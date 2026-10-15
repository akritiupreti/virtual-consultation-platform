# Testing Strategy

How the platform is tested and why. The guiding principle (from the reviewer) is
**cover the critical scenarios, don't just chase a coverage number**. Coverage
gates are a Phase 6 concern; the critical scenarios below are mandatory from
Phase 2 onward.

## Test pyramid

```mermaid
flowchart TB
    subgraph e2e [Integration / e2e · real Postgres]
        direction LR
        life[lifecycle] --- claim[claim concurrency] --- rbac[RBAC / separation of duties]
        rt[real-time live updates] --- ttl[claim-TTL requeue] --- wsauth[WS auth / authz]
    end
    subgraph unit [Unit · pure, no I/O]
        direction LR
        tr[transition registry] --- mx[authorization matrix + policy] --- au[auth service]
    end
    unit --> e2e
    e2e -.-> ui["Frontend component / a11y / visual<br/>(Phase 6)"]

    classDef later stroke-dasharray: 4 3;
    class ui later
```

- **Unit tests** (fast, no database) cover the pure decision logic — the transition
  registry and the authorization matrix/policy — plus the auth service with mocks.
  They run in the main CI job on every PR.
- **Integration / e2e tests** boot the real NestJS app against a **real PostgreSQL**
  database, because the guarantees that matter (DB-atomic claim, cross-role access)
  cannot be proven with mocks. They run in a dedicated CI job with a `postgres`
  service container.
- **Frontend component, accessibility and visual-regression** tests are scoped to
  Phase 6 (see below).

## Critical scenarios (mandatory)

These map directly to [success-criteria.md](success-criteria.md) and must always be
covered regardless of the coverage percentage.

| #    | Scenario                                                          | Where                                         | Proves                   |
| ---- | ----------------------------------------------------------------- | --------------------------------------------- | ------------------------ |
| CS-1 | Full lifecycle Requested → Summarized                             | `test/e2e/lifecycle.e2e-spec.ts`              | SC-1 / FR-17             |
| CS-2 | Contested claim → exactly one winner                              | `test/e2e/claim-concurrency.e2e-spec.ts`      | SC-2 / FR-9 / ADR-0003   |
| CS-3 | Invalid transitions rejected (409)                                | `transition-registry.spec.ts` + lifecycle e2e | SC-5 / FR-17             |
| CS-4 | Admin cannot read clinical content                                | `test/e2e/rbac.e2e-spec.ts`                   | SC-6 / FR-16             |
| CS-5 | No privilege escalation (role/ownership)                          | `authorization-matrix.spec.ts` + rbac e2e     | SC-7 / NFR-1             |
| CS-6 | Doctor-only finalize; nurse denied                                | lifecycle + rbac e2e                          | FR-13                    |
| CS-7 | Two subscribers see live queue/room updates                       | `test/e2e/realtime.e2e-spec.ts`               | FR-18 / C18 / ADR-0005   |
| CS-8 | Claimed-but-not-started auto-requeues + audited                   | `test/e2e/claim-ttl-requeue.e2e-spec.ts`      | FR-12 / SC-4 / ADR-0010  |
| CS-9 | WS connections authenticated; admin/non-participant refused rooms | `test/e2e/realtime.e2e-spec.ts`               | NFR-1 / invariants 3 & 4 |

### How the concurrency test proves correctness (CS-2)

It seeds one `QUEUED` consultation, then fires **many simultaneous claims** — both
directly against the service and over HTTP — with `Promise.all`/`allSettled`.
Exactly one must succeed; the rest must get `409`. Because the guarantee lives in
the database (a conditional `UPDATE` serialized by a row lock, [ADR-0003](adr/0003-claim-concurrency.md)),
this holds even across multiple API instances.

### How the real-time scenarios are proven (CS-7 / CS-8 / CS-9)

The real-time e2e boots the app on a real port and drives it with **two socket.io
clients**:

- **CS-7 (live updates):** two clinicians subscribe to the queue; a new request
  enqueued by a patient pushes `queue:updated` to **both**. In a room, a message
  sent by one participant arrives live at the other, and the patient receives a
  `position:updated` when a higher-priority case jumps ahead.
- **CS-9 (WS auth/authz):** an unauthenticated handshake is disconnected; a patient
  and an admin are refused `subscribe:queue`; an admin and a non-participant
  clinician are refused `join:consultation` — the same boundaries as REST
  (invariants 3 & 4).
- **CS-8 (claim-TTL requeue):** a case is claimed and its `claimed_at` back-dated
  past the TTL; one sweep requeues it (`CLAIMED → QUEUED`, `claimed_by` cleared) and
  writes exactly one `CONSULTATION_REQUEUED` audit row. A case still within the TTL,
  or already started, is left untouched.

These run on the single-instance in-memory adapter, so **Redis is not required** to
prove them; cross-instance fan-out (the Redis adapter) is validated separately with
Redis running (below).

## Running the tests

```bash
# Unit tests (no database) — fast, always runnable
npm test                                   # all workspaces
npm run test --workspace backend           # backend only

# Integration / e2e — require a real Postgres TEST database.
# A safety guard refuses to run unless DATABASE_URL names a *_test database,
# so your dev data is never truncated.
docker compose up -d db redis               # Postgres (host port from .env); redis is optional
#   one-time: create + migrate a throwaway test DB
#   (psql: CREATE DATABASE vcp_test;)
DATABASE_URL="postgresql://vcp:vcp_dev_password@localhost:5433/vcp_test?schema=public" \
  npx prisma migrate deploy --schema backend/src/prisma/schema.prisma
# A long sweep interval keeps the background claim-TTL tick from racing the
# deterministic CS-8 assertions; the tests drive the sweep directly.
DATABASE_URL="postgresql://vcp:vcp_dev_password@localhost:5433/vcp_test?schema=public" \
  REDIS_URL="redis://localhost:6379" \
  CLAIM_TTL_SWEEP_INTERVAL_SECONDS=3600 \
  npm run test:e2e --workspace backend
```

`REDIS_URL` is optional for the suite (CS-7/8/9 pass on the in-memory adapter); set
it to also exercise the Redis adapter path. In CI the e2e job provisions
`postgres:16` **and** `redis:7` as services, materializes `.env`, runs
`prisma migrate deploy`, and then `test:e2e` — see `.github/workflows/ci.yml`.

### Cross-instance fan-out (manual)

The one behaviour that genuinely needs Redis is fan-out **across** API instances.
To check it by hand: start Redis, run two backends on different ports (both with the
same `REDIS_URL`), connect a clinician to each, and confirm a claim on one instance
updates the queue on the other.

## Coverage

- Targets (Phase 6, CI-gated): **backend ≥ 90%**, **frontend ≥ 80%** (NFR-7).
- Until then, coverage is observable (`npm run test:cov --workspace backend`) but not
  gated, so effort goes to the critical scenarios first.

## Accessibility & visual regression (Phase 6)

- **WCAG 2.1 AA** on the critical screens, verified with automated tooling (axe /
  Lighthouse) plus keyboard-navigation and contrast checks (NFR-6, C24).
- **Visual regression** on a fixed, small set of **critical screens** — login, triage
  queue, consultation room, summary — not the whole app (C25).
