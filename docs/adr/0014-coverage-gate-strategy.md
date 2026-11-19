# ADR-0014: Coverage gate strategy & thresholds

- **Status:** Accepted
- **Date:** 2026-10-22
- **Deciders:** Project owner

## Context

Phase 6 flips coverage from observe-only (Phase 5) to **CI-enforced**: backend ≥90%,
frontend ≥80% (NFR-7 / SC-10 / SC-11). A naïve reading — "gate the backend unit job"
— collapses on contact with this codebase: the backend's unit suite covers only the
pure decision logic, so **unit-only statement coverage is ~13%**. That is by design.
The guarantees that matter here — the DB-atomic claim (CS-2), the role+state
authorization boundaries (CS-4/5/13), real-time fan-out (CS-7/9), the claim-TTL
requeue (CS-8), correlation-ID tracing (CS-16) — **cannot be proven with mocks**, so
they live in the e2e suite against a real Postgres
([testing-strategy.md](../testing-strategy.md)). Chasing 90% with unit tests alone
would mean re-asserting that logic against mocked Prisma — the exact "chase the
coverage number" anti-pattern the reviewer warned against (C23).

## Decision

**Gate the backend on the _merged_ coverage of the unit and e2e suites**, and the
frontend on its Vitest component/unit coverage.

- Both backend suites run with Istanbul JSON coverage (`test:cov:unit`,
  `test:cov:e2e`). A small script drops each run's `coverage-final.json` into
  `.nyc_output`; **`nyc`** unions them and `nyc check-coverage` enforces the gate.
  A file is "covered" if **either** suite executed it, which is the honest picture
  of what the test effort actually exercises.
- **Backend thresholds:** statements / lines / functions **≥90%** (the headline
  NFR-7 metric); **branches ≥65%**. Branches get a lower floor because the branches
  that remain uncovered are socket-gateway handlers, health-probe up/down checks and
  config/degrade paths that the integration suite exercises in aggregate but that
  only contrived inputs would flip individually — forcing them is C23 all over again.
  The merged suite currently sits at ~93% statements / ~71% branches.
- **Frontend threshold:** statements / lines / functions / branches **≥80%** via
  Vitest's v8 provider, enforced in the `verify` CI job.
- **Exclusions** (excluded, not fake-tested): DI `*.module.ts`, DTO shells,
  `main.ts` bootstrap, the Prisma seed, and the **main-only** socket.io CORS adapter
  (`cors-io.adapter.ts`, installed in `main.ts` and never loaded by the in-process
  test app — excluded for the same reason as `main.ts`).
- The gate runs in the `integration` CI job, which already provisions Postgres; the
  `verify` job keeps a fast backend unit run for quick signal.

## Alternatives considered

- **Merged unit + e2e, nyc-enforced** (chosen) — reflects real coverage; keeps effort
  on the critical scenarios; standard Istanbul tooling.
- **Gate unit-only at 90%** — would force dozens of mock-heavy tests duplicating the
  e2e guarantees to lift a meaningless 13% number. Rejected (C23).
- **Count e2e coverage only** — simpler, but discards the fast unit tests' coverage of
  pure logic (transition registry, authz matrix) and would under-count.
- **Branches ≥80% (or ≥90%)** — unreachable without contrived inputs against
  transport/infra branches; a dishonest gate that invites fake tests. Rejected in
  favour of a documented, achievable floor.

## Consequences

- Adds the `nyc` dev dependency and a `merge-coverage.cjs` helper; backend gains
  `test:cov:unit`, `test:cov:e2e`, `coverage:merge`, `coverage:check`,
  `coverage:combined`.
- CI **enforces** the gates; a regression below threshold fails the build (SC-16).
- The branch floor is a deliberate, documented judgment — revisit it upward only by
  covering real logic, never by excluding awkward files or adding contrived tests.
- Coverage policy and the CI-pipeline diagram live in
  [testing-strategy.md](../testing-strategy.md).
