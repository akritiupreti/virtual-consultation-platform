# Architecture

How the Virtual Consultation Platform is structured, why, and where each
responsibility lives. This document is **diagram-first**: each section opens with
the picture, then explains it. It is updated as capabilities land — the claim-race
and lifecycle sequence diagrams landed in Phase 2 (§4); the real-time fan-out,
claim-TTL auto-requeue and reconnection sequences land in Phase 3 (§7).

Related: [data model](data-model.md) · [state machine](state-machine.md) ·
[authorization matrix](authorization-matrix.md) · [ADRs](adr/).

---

## 1. System context

```mermaid
flowchart LR
    patient([Patient])
    clinician([Nurse / Doctor])
    admin([Admin])

    subgraph client [Frontend · React + Vite · Phase 2]
        spa[Single-page app]
    end

    subgraph server [Backend · NestJS]
        api[REST API]
        ws["WebSocket gateway<br/>(socket.io · Phase 3)"]
    end

    db[(PostgreSQL<br/>system of record)]
    redis[("Redis<br/>presence · pub/sub<br/>cached positions")]
    obj[("Object storage<br/>attachments · Phase 4")]

    patient --> spa
    clinician --> spa
    admin --> spa
    spa -->|HTTPS / JSON| api
    spa -->|WSS| ws
    api --> db
    ws --> redis
    api --> redis
    api -.-> obj

    classDef later stroke-dasharray: 4 3;
    class obj later
```

The REST API and the WebSocket gateway (Phase 3) are both live; object storage
(dashed) arrives in Phase 4. The backend is the only thing that touches the
database — clients never do. Redis is reachable from both the gateway (pub/sub
fan-out, presence) and the API (cached positions), but it is **not** a source of
truth ([ADR-0004](adr/0004-redis-responsibilities.md)); PostgreSQL is.

---

## 2. Backend module structure

NestJS was chosen ([ADR-0001](adr/0001-backend-framework.md)) precisely because
its modules, guards and interceptors give clean, testable seams for the
cross-cutting concerns this domain needs (authorization, transition checks,
audit, correlation IDs).

```mermaid
flowchart TB
    subgraph app [AppModule]
        config[ConfigModule<br/>env]
        prisma[PrismaModule<br/>global DB client]
        auth[AuthModule<br/>register · login · JWT · /me]
        health[AppController<br/>/health]
    end

    subgraph phase2 [Phase 2 — MVP slice ✅]
        consult[ConsultationsModule<br/>state machine · DB-atomic claim<br/>lifecycle · derived queue]
        messaging[MessagingModule<br/>persisted messages]
        summaries[SummariesModule<br/>draft · doctor finalize]
        audit[AuditModule<br/>append-only audit log]
        authz[common/authz<br/>matrix · policy · RolesGuard]
        sm[common/state-machine<br/>transition registry]
    end

    subgraph phase3 [Phase 3 — real-time ✅]
        realtime[RealtimeModule<br/>WS gateway · fan-out<br/>presence · position cache]
        claimttl[ClaimTtlService<br/>start-TTL auto-requeue]
    end

    subgraph phase5 [Phase 5]
        common[CommonModule<br/>correlation IDs · metrics]
    end

    auth --> prisma
    consult --> prisma
    messaging --> prisma
    summaries --> prisma
    audit --> prisma
    consult --> audit
    messaging --> audit
    summaries --> audit
    consult --> authz
    consult --> sm
    authz --> sm
    consult --> realtime
    messaging --> realtime
    summaries --> realtime
    realtime --- claimttl
    claimttl --> audit
    realtime --> prisma

    classDef later stroke-dasharray: 4 3;
    class common later
```

The queue is **not** a module or a table — it is the set of `QUEUED` consultations
read straight from Postgres, ordered by priority tier then FIFO, so there is no
second source of truth to keep in sync. `common/authz` and `common/state-machine`
are plain, dependency-free units (a matrix, a policy function, a transition
registry) that both the controllers and services read — the single definition of
who-may-do-what-when (invariants 1 & 4).

| Module                 | Responsibility                                                                                              | Phase                 |
| ---------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------- |
| `ConfigModule`         | Load env (`../.env`), expose typed config                                                                   | 1                     |
| `PrismaModule`         | Single global Prisma client; connection lifecycle                                                           | 1                     |
| `AuthModule`           | Register (patient), login, JWT issue/verify, `GET /auth/me`                                                 | 1                     |
| `AppController`        | Unauthenticated `GET /health` liveness                                                                      | 1                     |
| `ConsultationsModule`  | State-machine enforcement, DB-atomic claim, lifecycle, derived priority+FIFO queue, "N ahead" positions     | 2 ✅ (real-time in 3) |
| `MessagingModule`      | Persisted messages (REST); WebSocket room in Phase 3                                                        | 2 ✅ / 3              |
| `SummariesModule`      | Draft (assigned clinician) + doctor-only finalize; immutable                                                | 2 ✅                  |
| `AuditModule`          | Append-only audit events (no clinical content); admin-only read                                             | 2 ✅ / 4              |
| `common/authz`         | Authorization matrix, role+state+ownership policy, `RolesGuard`                                             | 2 ✅                  |
| `common/state-machine` | Transition registry (the central bank of transitions)                                                       | 2 ✅                  |
| `RealtimeModule`       | WebSocket gateway (JWT handshake, room authz), Redis fan-out + presence + position cache, claim-TTL sweeper | 3 ✅                  |
| `CommonModule`         | Validation helpers, error mapping, correlation-ID middleware, metrics                                       | 5                     |

### Authorization seams (where the invariants are enforced)

```mermaid
flowchart LR
    req[Incoming request] --> jwtg[JwtAuthGuard<br/>authenticated?]
    jwtg --> roleg["RolesGuard<br/>coarse role gate<br/>(@Roles on the route)"]
    roleg --> svc[Controller → Service]
    svc --> pol["authorizeConsultationAction()"]
    subgraph policy [single authorization composition]
        pol --> r["1 · role<br/>authorization matrix"]
        r --> st["2 · state<br/>transition registry"]
        st --> own["3 · ownership<br/>owner / assigned / participant"]
    end
    own --> do[Mutate + audit]
```

`JwtAuthGuard` authenticates; `RolesGuard` fails fast on the route's allowed
roles; then the service runs `authorizeConsultationAction` — the **one** place
that composes **role → state → ownership**, reading the authorization matrix and
the shared transition registry. Ordering the checks this way makes the HTTP code
correct: a disallowed role is `403`, an action illegal from the current state is
`409`, and a wrong owner is `403` (invariants 1, 3 & 4). State-changing actions
then write an audit record in the same path (invariant 5).

---

## 3. Authentication request flow (Phase 1, implemented)

```mermaid
sequenceDiagram
    autonumber
    participant C as Client
    participant A as AuthController
    participant S as AuthService
    participant DB as PostgreSQL

    C->>A: POST /auth/register {email, password}
    A->>S: register(dto)
    S->>DB: find user by email
    DB-->>S: none
    S->>S: bcrypt.hash(password)
    S->>DB: create user (role = PATIENT)
    S-->>A: {accessToken, user}
    A-->>C: 201 {accessToken, user}

    C->>A: GET /auth/me (Authorization: Bearer <token>)
    A->>A: JwtAuthGuard verifies token
    A-->>C: 200 {id, email, role}
```

Self-registration always creates a **PATIENT**; staff (nurse/doctor/admin) are
provisioned by seed or by an admin later (prevents privilege escalation, NFR-1).
Access tokens are short-lived JWTs ([ADR-0006](adr/0006-authn-authz.md)); refresh
tokens are a Phase 2 addition.

---

## 4. Data & concurrency

PostgreSQL is the durable system of record ([ADR-0002](adr/0002-postgresql-system-of-record.md));
the full schema and ER diagram live in [data-model.md](data-model.md). Redis is
deliberately _not_ a source of truth ([ADR-0004](adr/0004-redis-responsibilities.md)).

### 4.1 The claim race (ADR-0003, invariant 2)

Two clinicians may claim the same queued case at the same instant. The race is
resolved **in the database** by a single atomic conditional `UPDATE` — never by
application-level coordination. Whichever transaction's update matches one row
wins; the other matches zero rows and is told it was already claimed.

```mermaid
sequenceDiagram
    autonumber
    participant A as Nurse A
    participant B as Nurse B
    participant S as ConsultationsService
    participant DB as PostgreSQL (row lock)

    Note over A,B: Both see the same QUEUED case and claim simultaneously
    A->>S: POST /consultations/:id/claim
    B->>S: POST /consultations/:id/claim
    S->>DB: UPDATE consultations SET state='CLAIMED', claimed_by=A, version=version+1<br/>WHERE id=:id AND state='QUEUED' AND claimed_by IS NULL
    S->>DB: UPDATE consultations SET state='CLAIMED', claimed_by=B, version=version+1<br/>WHERE id=:id AND state='QUEUED' AND claimed_by IS NULL
    Note over DB: Row lock serializes the two UPDATEs
    DB-->>S: A → 1 row affected
    DB-->>S: B → 0 rows affected (predicate no longer true)
    S-->>A: 200 OK — CLAIMED by A
    S-->>B: 409 Conflict — already claimed
```

Prisma expresses this as `updateMany({ where: { id, state: QUEUED, claimedBy: null }, … })`;
`result.count === 1` is the winner, `0` ⇒ `409`. The same conditional-update
pattern guards every other transition (start / complete / cancel), so a state that
moves under a request is caught as a zero-row result rather than a lost update.
This is proven by `backend/test/e2e/claim-concurrency.e2e-spec.ts` (SC-2).

### 4.2 Lifecycle request flow

```mermaid
sequenceDiagram
    autonumber
    participant P as Patient
    participant C as Clinician
    participant D as Doctor
    participant API as Backend
    participant DB as PostgreSQL

    P->>API: POST /consultations (intake + consent)
    API->>DB: create REQUESTED → update QUEUED (one tx, both audited)
    C->>API: GET /consultations/queue (minimal pre-claim view)
    C->>API: POST :id/claim  (DB-atomic) → CLAIMED
    C->>API: POST :id/start  (cap check) → IN_SESSION
    P->>API: POST :id/messages
    C->>API: POST :id/messages
    C->>API: POST :id/complete → ENDED
    C->>API: POST :id/summary (draft)
    D->>API: POST :id/summary/finalize → SUMMARIZED (immutable)
    P->>API: GET :id/summary (finalized only)
```

---

## 5. Local deployment topology (Phase 1)

```mermaid
flowchart TB
    subgraph host [Developer machine]
        node["Backend (NestJS)<br/>node / nest start<br/>:3000"]
        subgraph compose [Docker Compose]
            pg[("postgres:16-alpine<br/>container :5432<br/>host :\${POSTGRES_PORT}")]
            vol[(named volume<br/>vcp-db-data)]
        end
        node -->|DATABASE_URL| pg
        pg --- vol
    end
```

Phase 1 runs the API on the host (fast reload) against a Dockerised Postgres. The
full stack — app container + Redis — is assembled in Phase 5. The target is
**local Docker Compose** ([ADR-0008](adr/0008-deployment-target.md)); no hosted
environment is in scope for the capstone.

### Environment & configuration

A single git-ignored `.env` at the repo root feeds both Docker Compose and the
backend; `.env.example` is the committed, canonical list of variables. The host
port is configurable (`POSTGRES_PORT`) to avoid clashes with other local Postgres
instances.

---

## 6. Build, test & CI

```mermaid
flowchart LR
    install[npm ci] --> gen[prisma generate]
    gen --> validate[prisma validate]
    validate --> lint[eslint]
    lint --> typecheck[tsc --noEmit]
    typecheck --> test[jest]
```

CI runs this chain on every PR and on `main` (`.github/workflows/ci.yml`). Build,
integration/E2E and coverage gates are layered on in Phases 2–6
([project-plan.md](project-plan.md)). The repo is an **npm workspaces monorepo**
(`backend`, `frontend`) sharing one TypeScript base config, ESLint (flat) and
Prettier, with Conventional-Commit enforcement via husky + commitlint.

---

## 7. Real-time & concurrency hardening (Phase 3)

The triage queue and the consultation room go **live** over WebSockets
([ADR-0005](adr/0005-realtime-websockets.md)), fanned out across API instances by
Redis pub/sub ([ADR-0004](adr/0004-redis-responsibilities.md)). The transport is
socket.io with the `@socket.io/redis-adapter`
([ADR-0009](adr/0009-realtime-implementation.md)); the claim-start TTL is a
DB-authoritative sweeper ([ADR-0010](adr/0010-claim-start-ttl.md)). Two rules keep
the real-time layer honest:

- **PostgreSQL stays authoritative.** Every event is emitted _after_ the DB change
  commits; clients treat events as _signals_ and reconcile the real state from REST
  (and from the DB behind it). Redis is speed/ephemerality only.
- **The matrix governs WebSockets too.** The JWT is verified on the handshake;
  joining the `queue` room is clinician-only and joining a `consultation:<id>` room
  runs the same `authorizeConsultationAction` (role → state → ownership) as REST —
  so admins and non-participants are refused (invariants 3 & 4).

Events (no clinical content beyond what the room's members may already see):
`queue:updated` (signal → re-fetch the queue), `consultation:updated`
(state changed), `message:created` (into the private room only),
`position:updated` (a patient's "N ahead"), `presence:updated`.

### 7.1 Real-time fan-out across instances

```mermaid
sequenceDiagram
    autonumber
    participant N1 as Nurse A (API-1)
    participant S as ConsultationsService (API-1)
    participant DB as PostgreSQL
    participant RT as RealtimeService (API-1)
    participant R as Redis (pub/sub)
    participant G2 as Gateway (API-2)
    participant N2 as Nurse B (API-2)

    Note over N2: Nurse B is subscribed to the "queue" room on a different instance
    N1->>S: POST /consultations/:id/claim
    S->>DB: atomic conditional UPDATE (→ CLAIMED)
    DB-->>S: 1 row (winner)
    S->>RT: notifyQueueChanged("claimed", id)
    RT->>R: publish queue:updated → room "queue"
    R-->>G2: deliver to subscribers on API-2
    G2-->>N2: emit queue:updated
    N2->>S: GET /consultations/queue (reconcile authoritative state)
    Note over RT,DB: positions recomputed from the DB and pushed to each waiting patient
```

A change made on one instance reaches a subscriber on another because the socket
adapter publishes to Redis and every instance's gateway is subscribed. Without
Redis the same path works within a single instance (in-memory adapter) and simply
does not cross instances — core flows are unaffected.

### 7.2 Claim-start TTL auto-requeue (FR-12 / SC-4)

```mermaid
sequenceDiagram
    autonumber
    participant C as Clinician
    participant S as ConsultationsService
    participant DB as PostgreSQL
    participant SW as ClaimTtlService (sweeper)
    participant A as AuditService
    participant RT as RealtimeService

    C->>S: POST /consultations/:id/claim → CLAIMED (claimed_at set)
    Note over C: Clinician never starts the session…
    loop every CLAIM_TTL_SWEEP_INTERVAL_SECONDS
        SW->>DB: find CLAIMED, started_at IS NULL, claimed_at < now − TTL
        DB-->>SW: overdue case(s)
        SW->>DB: atomic UPDATE WHERE state=CLAIMED AND started_at IS NULL<br/>(→ QUEUED, claimed_by=NULL)
        DB-->>SW: 1 row (requeued) · 0 if started in time / already swept
        SW->>A: audit CONSULTATION_REQUEUED (system actor)
        SW->>RT: broadcast consultation:updated + notifyQueueChanged("requeued")
    end
```

The requeue uses the same atomic conditional-update pattern as the claim, so a
race with a legitimate `start` is resolved in the database (exactly one of them
affects the row) and two instances sweeping at once is safe. The sweeper reconciles
from the DB on every tick, so it survives restarts.

### 7.3 Reconnection — reconcile from authoritative state

```mermaid
sequenceDiagram
    autonumber
    participant Cl as Client
    participant G as Gateway
    participant DB as PostgreSQL

    Note over Cl,DB: Connection drops (network blip). Server state is UNCHANGED.
    Cl-->>G: socket disconnects (presence decremented)
    Cl->>G: reconnect with JWT in handshake
    G->>G: verify token, re-join user room
    Cl->>G: re-emit subscribe:queue / join:consultation
    G->>G: re-authorize (matrix) and re-join rooms
    Cl->>DB: GET queue / consultation / messages (via REST)
    Note over Cl: UI reconciles to the server's authoritative state — no lost or duplicated work
```

Connection loss changes nothing server-side (state-machine.md "connection loss"
exception). On reconnect the client re-authenticates, the gateway re-authorizes
every room join, and the UI pulls the authoritative state over REST — missed
events don't matter because the client re-reads the source of truth.
