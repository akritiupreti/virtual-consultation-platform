# Architecture

How the Virtual Consultation Platform is structured, why, and where each
responsibility lives. This document is **diagram-first**: each section opens with
the picture, then explains it. It is updated as capabilities land — the claim-race
and lifecycle sequence diagrams landed in Phase 2 (§4); the real-time fan-out,
claim-TTL auto-requeue and reconnection sequences land in Phase 3 (§7); the
attachment signed-URL and deactivation-reassignment sequences land in Phase 4 (§8).
Phase 5 adds the observability & ops cross-cutting concerns — structured logging,
correlation-ID tracing, health/readiness probes and metrics in
[observability.md](observability.md), and the full-stack Docker Compose topology and
CI/CD pipeline in [deployment.md](deployment.md).

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
    obj[("Object storage<br/>attachments · local FS<br/>signed-URL access")]

    patient --> spa
    clinician --> spa
    admin --> spa
    spa -->|HTTPS / JSON| api
    spa -->|WSS| ws
    api --> db
    ws --> redis
    api --> redis
    api --> obj
```

The REST API and the WebSocket gateway (Phase 3) are both live; object storage for
attachments arrives in Phase 4 as a local filesystem store reached only through
**app-issued signed URLs** ([ADR-0007](adr/0007-attachment-storage.md)) — the bytes
are never served directly. The backend is the only thing that touches the database —
clients never do. Redis is reachable from both the gateway (pub/sub fan-out,
presence) and the API (cached positions), but it is **not** a source of truth
([ADR-0004](adr/0004-redis-responsibilities.md)); PostgreSQL is.

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

    subgraph phase4 [Phase 4 — security ✅]
        attach[AttachmentsModule<br/>upload · signed-URL download<br/>local object store]
        usersm[UsersModule<br/>admin mgmt · deactivation<br/>mid-session reassignment]
        throttle[ThrottlerGuard<br/>auth + upload rate limits]
    end

    subgraph phase5 [Phase 5 — observability & ops ✅]
        common[CommonModule<br/>correlation IDs · metrics · logging]
        healthm[HealthModule<br/>/ready readiness probe]
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
    attach --> prisma
    attach --> audit
    usersm --> consult
    usersm --> realtime
    usersm --> audit
    common --> prisma
    audit --> common
    healthm --> prisma
    healthm --> realtime
```

The queue is **not** a module or a table — it is the set of `QUEUED` consultations
read straight from Postgres, ordered by priority tier then FIFO, so there is no
second source of truth to keep in sync. `common/authz` and `common/state-machine`
are plain, dependency-free units (a matrix, a policy function, a transition
registry) that both the controllers and services read — the single definition of
who-may-do-what-when (invariants 1 & 4).

| Module                 | Responsibility                                                                                                | Phase                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------------- | --------------------- |
| `ConfigModule`         | Load env (`../.env`), expose typed config                                                                     | 1                     |
| `PrismaModule`         | Single global Prisma client; connection lifecycle                                                             | 1                     |
| `AuthModule`           | Register (patient), login, JWT issue/verify, `GET /auth/me`                                                   | 1                     |
| `AppController`        | Unauthenticated `GET /health` liveness                                                                        | 1                     |
| `ConsultationsModule`  | State-machine enforcement, DB-atomic claim, lifecycle, derived priority+FIFO queue, "N ahead" positions       | 2 ✅ (real-time in 3) |
| `MessagingModule`      | Persisted messages (REST); WebSocket room in Phase 3                                                          | 2 ✅ / 3              |
| `SummariesModule`      | Draft (assigned clinician) + doctor-only finalize; immutable                                                  | 2 ✅                  |
| `AuditModule`          | Append-only audit events (no clinical content); admin-only read                                               | 2 ✅ / 4              |
| `common/authz`         | Authorization matrix, role+state+ownership policy, `RolesGuard`                                               | 2 ✅                  |
| `common/state-machine` | Transition registry (the central bank of transitions)                                                         | 2 ✅                  |
| `RealtimeModule`       | WebSocket gateway (JWT handshake, room authz), Redis fan-out + presence + position cache, claim-TTL sweeper   | 3 ✅                  |
| `AttachmentsModule`    | Upload (type/size/magic-byte validation), local object store, short-lived user-scoped signed-URL download     | 4 ✅                  |
| `UsersModule`          | Admin user management, deactivation/reactivation, mid-session reassignment of a deactivated clinician's cases | 4 ✅                  |
| `ThrottlerGuard`       | Global rate limiting with stricter auth/upload limits (ADR-0011)                                              | 4 ✅                  |
| `CommonModule`         | Correlation-ID store (ALS) + middleware, structured-logging config, Prometheus metrics + request interceptor  | 5 ✅                  |
| `HealthModule`         | `GET /ready` readiness probe — PostgreSQL gates, Redis non-gating (ADR-0004); liveness stays on `GET /health` | 5 ✅                  |

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
full stack — backend + frontend + Postgres + Redis — is assembled in Phase 5 behind
one `docker compose up`; the topology, host-port mapping and container lifecycle are
in [deployment.md](deployment.md). The target is **local Docker Compose**
([ADR-0008](adr/0008-deployment-target.md)); no hosted environment is in scope for
the capstone.

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

CI runs this chain on every PR and on `main` (`.github/workflows/ci.yml`). Phase 5
adds two more jobs: an **integration/e2e** job against a real Postgres + Redis, and a
**Docker image build** job that proves backend and frontend containerise (images are
built, not pushed — local Compose target, ADR-0008). Coverage is reported
**observe-only**; the gates are a Phase 6 concern. The full pipeline-stages diagram
is in [deployment.md](deployment.md). The repo is an **npm workspaces monorepo**
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

---

## 8. Security, privacy & audit (Phase 4)

Phase 4 hardens the sensitive-data paths without changing the invariants: the
single authorization matrix still governs everything, PostgreSQL stays
authoritative, and admins still cannot read clinical content. The full threat model
is in [security-privacy.md](security-privacy.md) and the audit catalogue in
[audit-logging.md](audit-logging.md).

### 8.1 Attachment upload & signed-URL retrieval (ADR-0007)

```mermaid
sequenceDiagram
    autonumber
    participant P as Participant (patient/clinician)
    participant API as AttachmentsService
    participant AZ as authorizeConsultationAction
    participant FS as Local object store
    participant DB as PostgreSQL
    participant SU as SignedUrlService

    Note over P,DB: Upload — participant only, IN_SESSION, JPEG/PNG/PDF ≤10MB
    P->>API: POST /consultations/:id/attachments (multipart)
    API->>AZ: UPLOAD_ATTACHMENT (role → state → ownership)
    API->>API: sniff magic bytes + match declared type (else 415)
    API->>FS: write bytes under opaque UUID key
    API->>DB: insert attachment row (metadata + storage_key)
    API->>DB: audit ATTACHMENT_UPLOADED (id/type/size only)
    API-->>P: 201 metadata

    Note over P,SU: Retrieval — short-lived, user-scoped signed URL
    P->>API: GET /consultations/:id/attachments
    API->>AZ: VIEW_ATTACHMENT (participant; admin denied)
    API->>SU: sign {attachmentId, userId, exp}
    API-->>P: 200 list + downloadUrl + expiresAt
    P->>API: GET /attachments/:id/download?token=…
    API->>SU: verify signature + expiry + id match (else 403)
    API->>DB: re-load bound user (must be ACTIVE) + re-run matrix
    API->>DB: audit ATTACHMENT_ACCESSED
    API->>FS: stream bytes
    API-->>P: 200 file (inline, private no-store)
```

The signed URL is a convenience, not an authority: the download handler re-enters
the same authorization pipeline every REST call uses, so an admin or non-participant
is refused even with a valid link, and a tampered/expired/mismatched token is `403`.
No PII or clinical data is ever in the URL.

### 8.2 Deactivation & mid-session reassignment (ADR-0012)

```mermaid
sequenceDiagram
    autonumber
    participant Ad as Admin
    participant U as UsersService
    participant DB as PostgreSQL
    participant C as ConsultationsService
    participant RT as RealtimeService
    participant Cl as Deactivated clinician
    participant Pt as Patient

    Ad->>U: POST /users/:id/deactivate
    U->>DB: set status = DEACTIVATED (soft)
    U->>DB: audit USER_DEACTIVATED
    U->>C: reassignActiveCasesOf(clinicianId)
    loop each CLAIMED / IN_SESSION case
        C->>DB: atomic UPDATE → QUEUED, clear claimed_by/started_at<br/>WHERE claimed_by=:id AND state IN (CLAIMED, IN_SESSION)
        C->>DB: audit CONSULTATION_REASSIGNED (system actor)
        C->>RT: broadcast consultation:updated (→ QUEUED)
    end
    C->>RT: notifyQueueChanged("reassigned")
    RT-->>Pt: consultation:updated + position:updated (picked up again)
    U->>RT: disconnectUser(clinicianId)
    RT-->>Cl: sockets dropped
    Note over Cl: next REST request / WS handshake → 401 (status re-checked)
```

The reassignment reuses the atomic conditional-update pattern of the claim/TTL
sweeper, so a race with the clinician's own last action resolves in the database.
The patient keeps their original `enqueued_at`, so they do not lose their place in
line, and is notified live (reconciling from REST on reconnect if offline).
