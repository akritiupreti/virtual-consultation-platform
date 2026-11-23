# Architecture

How the Virtual Consultation Platform is structured, why, and where each
responsibility lives. This document is **diagram-first**: each section opens with
the picture, then explains it. It is updated as capabilities land — the claim-race
and lifecycle sequence diagrams landed in Phase 2 (§4); the real-time fan-out,
claim-TTL auto-requeue and reconnection sequences land in Phase 3 (§7); the
deactivation sequence lands in Phase 4 (§8).
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

    patient --> spa
    clinician --> spa
    admin --> spa
    spa -->|HTTPS / JSON| api
    spa -->|WSS| ws
    api --> db
    ws --> db
```

The REST API and the WebSocket gateway (Phase 3) are the backend's two doors. The
backend is the only thing that touches the database — clients never do. Both doors
read it: the gateway checks PostgreSQL when a socket connects (is the account still
active?) and when it joins a consultation room (authorization). PostgreSQL is the
single source of truth; there is no second store to keep in sync.

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
        realtime[RealtimeModule<br/>WS gateway · rooms<br/>live fan-out]
        claimttl[ClaimTtlService<br/>start-TTL auto-requeue]
    end

    subgraph phase4 [Phase 4 — security ✅]
        usersm[UsersModule<br/>admin mgmt · deactivation<br/>not during a session]
        throttle[ThrottlerGuard<br/>auth rate limit]
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
    usersm --> prisma
    usersm --> realtime
    usersm --> audit
    common --> prisma
    audit --> common
    healthm --> prisma
```

The queue is **not** a module or a table — it is the set of `QUEUED` consultations
read straight from Postgres, ordered by priority tier then FIFO, so there is no
second source of truth to keep in sync. `common/authz` and `common/state-machine`
are plain, dependency-free units (a matrix, a policy function, a transition
registry) that both the controllers and services read — the single definition of
who-may-do-what-when (invariants 1 & 4).

| Module                 | Responsibility                                                                                          | Phase                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------- | --------------------- |
| `ConfigModule`         | Load env (`../.env`), expose typed config                                                               | 1                     |
| `PrismaModule`         | Single global Prisma client; connection lifecycle                                                       | 1                     |
| `AuthModule`           | Register (patient), login, JWT issue/verify, `GET /auth/me`                                             | 1                     |
| `AppController`        | Unauthenticated `GET /health` liveness                                                                  | 1                     |
| `ConsultationsModule`  | State-machine enforcement, DB-atomic claim, lifecycle, derived priority+FIFO queue, "N ahead" positions | 2 ✅ (real-time in 3) |
| `MessagingModule`      | Persisted messages (REST); WebSocket room in Phase 3                                                    | 2 ✅ / 3              |
| `SummariesModule`      | Draft (assigned clinician) + doctor-only finalize; immutable                                            | 2 ✅                  |
| `AuditModule`          | Append-only audit events (no clinical content); admin-only read                                         | 2 ✅ / 4              |
| `common/authz`         | Authorization matrix, role+state+ownership policy, `RolesGuard`                                         | 2 ✅                  |
| `common/state-machine` | Transition registry (the central bank of transitions)                                                   | 2 ✅                  |
| `RealtimeModule`       | WebSocket gateway (JWT handshake, room authz), live fan-out to rooms, claim-TTL sweeper                 | 3 ✅                  |
| `UsersModule`          | Admin user management, deactivation/reactivation (refused while the user is in an active session)       | 4 ✅                  |
| `ThrottlerGuard`       | Global rate limiting with a stricter auth limit                                                         | 4 ✅                  |
| `CommonModule`         | Correlation-ID store (ALS) + middleware, structured-logging config, Prometheus metrics                  | 5 ✅                  |
| `HealthModule`         | `GET /ready` readiness probe gated on PostgreSQL; liveness stays on `GET /health`                       | 5 ✅                  |

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
Access tokens are short-lived JWTs ([ADR-0005](adr/0005-authn-authz.md)); refresh
tokens are a Phase 2 addition.

---

## 4. Data & concurrency

PostgreSQL is the durable system of record ([ADR-0002](adr/0002-postgresql-system-of-record.md));
the full schema and ER diagram live in [data-model.md](data-model.md).

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
    D->>API: GET :id/summary (finalizing doctor retains read · ADR-0009)
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
full stack — backend + frontend + Postgres — is assembled in Phase 5 behind
one `docker compose up`; the topology, host-port mapping and container lifecycle are
in [deployment.md](deployment.md). The target is **local Docker Compose**
([ADR-0006](adr/0006-deployment-target.md)); no hosted environment is in scope for
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
    pr([PR / main]) --> verify & integration & a11y[accessibility-visual] & docker
    verify --> V["lint · typecheck · backend unit ·<br/>frontend coverage GATE ≥80%"]
    integration --> I["migrate · unit+e2e coverage ·<br/>nyc merge · GATE ≥90%"]
    a11y --> A["Playwright container:<br/>axe WCAG 2.1 AA · visual baselines"]
    docker --> D["build backend + frontend images<br/>(no push)"]
```

CI runs these jobs on every PR and on `main` (`.github/workflows/ci.yml`). The
**integration/e2e** job runs against a real Postgres; the **docker** job proves
both images containerise (built, not pushed — local Compose target, ADR-0006). As of
**Phase 6** coverage is **gate-enforced**, not observe-only: the frontend Vitest gate
(≥80%) runs in `verify`, and the **merged** backend unit + e2e coverage gate (≥90%
statements/lines/functions) runs in `integration` via `nyc`
([testing-strategy.md](testing-strategy.md#coverage-ci-enforced)). A fourth job,
**accessibility-visual**, runs axe WCAG 2.1 AA and visual-regression on the four
critical screens inside the pinned Playwright container ([testing-strategy.md](testing-strategy.md)). Full
pipeline detail is in [testing-strategy.md](testing-strategy.md) and
[deployment.md](deployment.md). The repo is an **npm workspaces monorepo**
(`backend`, `frontend`) sharing one TypeScript base config, ESLint (flat) and
Prettier, with Conventional-Commit enforcement via husky + commitlint.

---

## 7. Real-time & concurrency hardening (Phase 3)

The triage queue and the consultation room go **live** over WebSockets
([ADR-0004](adr/0004-realtime-websockets.md)). The transport is socket.io, with
rooms as the authorization unit ([ADR-0004](adr/0004-realtime-websockets.md));
the claim-start TTL is a
DB-authoritative sweeper ([ADR-0007](adr/0007-claim-start-ttl.md)). Two rules keep
the real-time layer honest:

- **PostgreSQL stays authoritative.** Every event is emitted _after_ the DB change
  commits; clients treat events as _signals_ and reconcile the real state from REST
  (and from the DB behind it).
- **The matrix governs WebSockets too.** The JWT is verified on the handshake;
  joining the `queue` room is clinician-only and joining a `consultation:<id>` room
  runs the same `authorizeConsultationAction` (role → state → ownership) as REST —
  so admins and non-participants are refused (invariants 3 & 4). Every user is in
  their personal `user:<id>` room, and every doctor in the `signoff` room — both
  derived from the verified JWT on connect, never requested by the client.

Events (no clinical content beyond what the room's members may already see):
`queue:updated` (signal → re-fetch the queue), `consultation:updated`
(state changed — also to the assigned clinician's personal room),
`message:created` (into the private room only), `position:updated` (a patient's
"N ahead") and `summary:updated` (content-free; doctors + the assignee). The
full contract is in [api-spec.md §WebSocket API](api-spec.md#websocket-api-phase-3).

### 7.1 Real-time fan-out to the queue room

```mermaid
sequenceDiagram
    autonumber
    participant N1 as Nurse A
    participant S as ConsultationsService
    participant DB as PostgreSQL
    participant RT as RealtimeService
    participant G as Gateway (socket.io rooms)
    participant N2 as Nurse B

    Note over N2: Nurse B is subscribed to the "queue" room
    N1->>S: POST /consultations/:id/claim
    S->>DB: atomic conditional UPDATE (→ CLAIMED)
    DB-->>S: 1 row (winner)
    S->>RT: notifyQueueChanged("claimed", id)
    RT->>G: emit queue:updated → room "queue"
    G-->>N2: queue:updated
    N2->>S: GET /consultations/queue (reconcile authoritative state)
    Note over RT,DB: positions recomputed from the DB and pushed to each waiting patient
```

The event is only a nudge: Nurse B's screen re-reads the queue over REST, so what
they see always comes from PostgreSQL, never from the event itself.

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
    Cl-->>G: socket disconnects
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

### 7.4 Live summary hand-off — nurse drafts, any doctor signs (ADR-0004, ADR-0009)

A nurse-run case is signed off by **any** doctor (ADR-0009), so summary changes are
signalled to the `signoff` room (every doctor) and to the drafter's personal room —
never to the patient. Saving is explicit: nothing reaches a reviewer while
the drafter is still typing.

```mermaid
sequenceDiagram
    autonumber
    actor N as Nurse (drafter)
    participant API as API (summaries)
    participant RT as RealtimeService
    actor D as Doctor (any)

    N->>API: Save draft (POST /summary), then End consultation
    API->>RT: summary:updated {id, reason}
    RT-->>D: signoff room → worklist shows the case
    Note over N: edits again — "Unsaved changes", nothing sent
    N->>API: Save draft (revision)
    API->>RT: summary:updated {id, drafted}
    RT-->>D: open review re-reads the draft over REST
    D->>API: Finalize & sign off → SUMMARIZED
    API->>RT: consultation:updated + summary:updated {finalized}
    RT-->>N: list + room show the signed summary
```

The signals carry an id and a reason only; every read goes back through REST and the
authorization matrix, so the live path never widens exposure (invariants 4 & 6).

---

## 8. Security, privacy & audit (Phase 4)

Phase 4 hardens the sensitive-data paths without changing the invariants: the
single authorization matrix still governs everything, PostgreSQL stays
authoritative, and admins still cannot read clinical content. The full threat model
is in [security-privacy.md](security-privacy.md) and the audit catalogue in
[audit-logging.md](audit-logging.md).

### 8.1 Deactivation during an active session (ADR-0008)

```mermaid
sequenceDiagram
    autonumber
    participant Ad as Admin
    participant U as UsersService
    participant DB as PostgreSQL
    participant RT as RealtimeService
    participant X as Deactivated user

    Ad->>U: POST /users/:id/deactivate
    U->>DB: UPDATE users SET status = DEACTIVATED<br/>WHERE id=:id AND status=ACTIVE<br/>AND no IN_SESSION consultation (as patient or clinician)
    alt user is in an active session
        DB-->>U: 0 rows
        U-->>Ad: 409 — try again after the session ends
    else not in a session
        DB-->>U: 1 row
        U->>DB: audit USER_DEACTIVATED
        U->>RT: disconnectUser(id)
        RT-->>X: sockets dropped
        U-->>Ad: 200 (deactivated)
        Note over X: next REST request / WS handshake → 401 (status re-checked)
    end
```

The rule lives inside the `UPDATE` itself, so the check and the write cannot be split
by a session starting in between — the same conditional-update pattern as the claim.
A clinician who has only **claimed** a case (not started it) can be deactivated: the
claim-start TTL sweeper (§7.2) returns that case to the queue and the patient keeps
their place in line.
