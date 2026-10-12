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

| #    | Scenario                                 | Where                                         | Proves                 |
| ---- | ---------------------------------------- | --------------------------------------------- | ---------------------- |
| CS-1 | Full lifecycle Requested → Summarized    | `test/e2e/lifecycle.e2e-spec.ts`              | SC-1 / FR-17           |
| CS-2 | Contested claim → exactly one winner     | `test/e2e/claim-concurrency.e2e-spec.ts`      | SC-2 / FR-9 / ADR-0003 |
| CS-3 | Invalid transitions rejected (409)       | `transition-registry.spec.ts` + lifecycle e2e | SC-5 / FR-17           |
| CS-4 | Admin cannot read clinical content       | `test/e2e/rbac.e2e-spec.ts`                   | SC-6 / FR-16           |
| CS-5 | No privilege escalation (role/ownership) | `authorization-matrix.spec.ts` + rbac e2e     | SC-7 / NFR-1           |
| CS-6 | Doctor-only finalize; nurse denied       | lifecycle + rbac e2e                          | FR-13                  |

### How the concurrency test proves correctness (CS-2)

It seeds one `QUEUED` consultation, then fires **many simultaneous claims** — both
directly against the service and over HTTP — with `Promise.all`/`allSettled`.
Exactly one must succeed; the rest must get `409`. Because the guarantee lives in
the database (a conditional `UPDATE` serialized by a row lock, [ADR-0003](adr/0003-claim-concurrency.md)),
this holds even across multiple API instances.

## Running the tests

```bash
# Unit tests (no database) — fast, always runnable
npm test                                   # all workspaces
npm run test --workspace backend           # backend only

# Integration / e2e — require a real Postgres TEST database.
# A safety guard refuses to run unless DATABASE_URL names a *_test database,
# so your dev data is never truncated.
docker compose up -d db                     # start Postgres (host port from .env)
#   one-time: create + migrate a throwaway test DB
#   (psql: CREATE DATABASE vcp_test;)
DATABASE_URL="postgresql://vcp:vcp_dev_password@localhost:5433/vcp_test?schema=public" \
  npx prisma migrate deploy --schema backend/src/prisma/schema.prisma
DATABASE_URL="postgresql://vcp:vcp_dev_password@localhost:5433/vcp_test?schema=public" \
  npm run test:e2e --workspace backend
```

In CI the e2e job provisions `postgres:16` as a service, materializes `.env`,
runs `prisma migrate deploy`, and then `test:e2e` — see `.github/workflows/ci.yml`.

## Coverage

- Targets (Phase 6, CI-gated): **backend ≥ 90%**, **frontend ≥ 80%** (NFR-7).
- Until then, coverage is observable (`npm run test:cov --workspace backend`) but not
  gated, so effort goes to the critical scenarios first.

## Accessibility & visual regression (Phase 6)

- **WCAG 2.1 AA** on the critical screens, verified with automated tooling (axe /
  Lighthouse) plus keyboard-navigation and contrast checks (NFR-6, C24).
- **Visual regression** on a fixed, small set of **critical screens** — login, triage
  queue, consultation room, summary — not the whole app (C25).
