# Testing Strategy

How the platform is tested and why. The guiding principle (from the reviewer) is
**cover the critical scenarios, don't just chase a coverage number**. The critical
scenarios below are mandatory from Phase 2 onward; as of **Phase 6** the coverage
gates, accessibility checks and visual-regression baselines are **finalized and
CI-enforced** (NFR-6/7, SC-10/11/13, C23/24/25).

## Test pyramid

Every tier below is now real and runs in CI; the frontend tiers (component, a11y,
visual) were added in Phase 6.

```mermaid
flowchart TB
    subgraph browser [Browser · Playwright + real Chromium · 4 critical screens]
        direction LR
        axe[axe WCAG 2.1 AA + contrast] --- vis[visual-regression screenshots] --- kbd[keyboard reachability]
    end
    subgraph fe [Frontend component · Vitest + RTL + jsdom]
        direction LR
        screens[login · triage · room · summary] --- jaxe[jest-axe AA + keyboard] --- libs[api / auth / realtime] --- contrast[token-contrast check]
    end
    subgraph e2e [Integration / e2e · real Postgres]
        direction LR
        life[lifecycle] --- claim[claim concurrency] --- rbac[RBAC / separation of duties]
        rt[real-time live updates] --- ttl[claim-TTL requeue] --- wsauth[WS auth / authz]
        obs[correlation-ID tracing] --- ready[readiness probe] --- metr[metrics endpoint]
    end
    subgraph unit [Backend unit · pure, no I/O]
        direction LR
        tr[transition registry] --- mx[authorization matrix + policy] --- au[auth service]
        svc[service guards: summaries · consultations · users · realtime]
    end
    unit --> e2e --> fe --> browser
```

- **Backend unit tests** (fast, no database) cover the pure decision logic — the
  transition registry, the authorization matrix/policy, the auth service — plus the
  service-level guard branches (summary immutability, claim and re-priority guards,
  the deactivation rule, real-time room targeting) with Prisma mocked. They run on
  every PR.
- **Integration / e2e tests** boot the real NestJS app against a **real PostgreSQL**,
  because the guarantees that matter (DB-atomic claim, cross-role access, real-time
  fan-out, readiness) cannot be proven with mocks. They run in a dedicated CI job with
  a `postgres` service container.
- **Frontend component tests** (Vitest + React Testing Library + jsdom,
  [ADR-0013](adr/0013-frontend-test-runner.md)) render each critical screen with the
  API/realtime layers mocked, asserting behaviour, `jest-axe` AA structure and
  keyboard interaction; lib tests cover the api/auth/realtime clients; a
  token-contrast test pins WCAG ratios.
- **Browser tests** (Playwright + real Chromium) run `@axe-core/playwright` (AA incl.
  computed contrast) and pixel visual-regression on the four critical screens, against
  a static build with the backend stubbed.

## Critical scenarios (mandatory)

These map directly to [success-criteria.md](success-criteria.md) and must always be
covered regardless of the coverage percentage.

| #     | Scenario                                                              | Where                                                    | Proves                   |
| ----- | --------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------ |
| CS-1  | Full lifecycle Requested → Summarized                                 | `test/e2e/lifecycle.e2e-spec.ts`                         | SC-1 / FR-17             |
| CS-2  | Contested claim → exactly one winner                                  | `test/e2e/claim-concurrency.e2e-spec.ts`                 | SC-2 / FR-9 / ADR-0003   |
| CS-3  | Invalid transitions rejected (409)                                    | `transition-registry.spec.ts` + lifecycle e2e            | SC-5 / FR-17             |
| CS-4  | Admin cannot read clinical content                                    | `test/e2e/rbac.e2e-spec.ts`                              | SC-6 / FR-16             |
| CS-5  | No privilege escalation (role/ownership)                              | `authorization-matrix.spec.ts` + rbac e2e                | SC-7 / NFR-1             |
| CS-6  | Doctor-only finalize; nurse denied                                    | lifecycle + rbac e2e                                     | FR-13                    |
| CS-7  | Two subscribers see live queue/room updates                           | `test/e2e/realtime.e2e-spec.ts`                          | FR-18 / C18 / ADR-0004   |
| CS-8  | Claimed-but-not-started auto-requeues + audited                       | `test/e2e/claim-ttl-requeue.e2e-spec.ts`                 | FR-12 / SC-4 / ADR-0008  |
| CS-9  | WS connections authenticated; admin/non-participant refused rooms     | `test/e2e/realtime.e2e-spec.ts`                          | NFR-1 / invariants 3 & 4 |
| CS-10 | Messages reach only the two participants (REST + private WS room)     | `test/e2e/rbac.e2e-spec.ts` + realtime e2e               | SC-6 / SC-8 / FR-16      |
| CS-11 | No deactivation while the user is in an active session (409)          | `test/e2e/deactivation.e2e-spec.ts` + users unit spec    | FR-24 / ADR-0010         |
| CS-12 | A different doctor finds, reviews and signs off a nurse-run case      | `test/e2e/signoff.e2e-spec.ts`                           | FR-13 / ADR-0018         |
| CS-13 | Full privilege-escalation matrix (role × state × ownership)           | `authorization-matrix.spec.ts` + `rbac.e2e-spec.ts`      | SC-7 / NFR-1             |
| CS-14 | Deactivation: no login, token rejected, audited, reactivation works   | `test/e2e/deactivation.e2e-spec.ts`                      | FR-23/25                 |
| CS-15 | Admin audit query filters + paginates + excludes clinical content     | `test/e2e/audit-query.e2e-spec.ts`                       | FR-15 / SC-6             |
| CS-16 | A request is traceable end-to-end by correlation ID                   | `test/e2e/observability.e2e-spec.ts`                     | SC-15 / ADR-0011         |
| CS-17 | Readiness reflects its dependency (gated on Postgres)                 | `test/e2e/observability.e2e-spec.ts`                     | SC-15                    |
| CS-18 | No PII/clinical data (nor headers/query) ever reaches the logs        | `logging-redaction.spec.ts` + audit no-content (CS-15)   | SC-9 / NFR-2             |
| CS-19 | Summary hand-off is live, content-free, and never reaches the patient | `test/e2e/realtime.e2e-spec.ts` + room/worklist specs    | FR-13 / ADR-0021/0022    |
| CS-20 | A doctor's sign-off history lists only their own sign-offs            | `test/e2e/signoff.e2e-spec.ts` + consultations unit spec | ADR-0023                 |

### How the concurrency test proves correctness (CS-2)

It seeds one `QUEUED` consultation, then fires **many simultaneous claims** — both
directly against the service and over HTTP — with `Promise.all`/`allSettled`.
Exactly one must succeed; the rest must get `409`. Because the guarantee lives in
the database (a conditional `UPDATE` serialized by a row lock, [ADR-0003](adr/0003-claim-concurrency.md)),
this would hold even across multiple API instances.

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
- **CS-19 (live summary hand-off):** a nurse ends a case with a saved draft and a
  doctor's socket — in no consultation room — receives `summary:updated` via the
  `signoff` room; the nurse's saved revision reaches both the doctor and the nurse's
  personal room with **no summary text** in the signal; the sign-off reaches the
  doctor too; the patient, joined to the case room, receives **none** of these. The frontend specs prove the other
  half: typing never saves (only **Save** does), a live signal never overwrites text
  being edited, and the reviewer's copy and worklist refresh on the signal.
- **CS-8 (claim-TTL requeue):** a case is claimed and its `claimed_at` back-dated
  past the TTL; one sweep requeues it (`CLAIMED → QUEUED`, `claimed_by` cleared) and
  writes exactly one `CONSULTATION_REQUEUED` audit row. A case still within the TTL,
  or already started, is left untouched.

These run against a listening app with real socket.io clients — the same transport
the browser uses.

### How the security scenarios are proven (CS-10 … CS-15)

- **Participant-only messages (CS-10):** another patient, a non-assigned clinician
  and an admin are each denied reading and posting messages over REST; over WebSockets
  they are refused the private room (CS-9).
- **Deactivation during a session (CS-11):** with a consultation `IN_SESSION`, both
  the nurse and the patient get `409` on deactivate, nothing is audited and the nurse
  stays active; once the session ends the nurse can be deactivated and their token
  stops working. The users unit spec asserts the guard sits inside the `UPDATE`.
- **Doctor sign-off (CS-12, CS-20):** a nurse runs and drafts a case; a different
  doctor finds it on the worklist, reads the detail and draft, and signs it off; the
  case then appears in that doctor's history and not another doctor's, and nurses and
  patients are refused the worklist.
- **Privilege escalation (CS-13):** the matrix unit test asserts every cell (including
  user management) for each role, and the RBAC e2e asserts the denials end-to-end
  (admin/non-participant/cross-patient).
- **Deactivation (CS-14):** a deactivated user cannot log in and their existing token
  is rejected on the next request; `USER_DEACTIVATED` is audited; self-deactivation is
  `400`; reactivation restores login.
- **Audit query (CS-15):** a full lifecycle is driven, then the admin query is
  filtered by actor/event/consultation and paginated; a scan of the whole response
  asserts no message body or summary text ever appears (SC-6); a non-admin is `403`.

### How the observability scenarios are proven (CS-16 … CS-18)

- **Correlation ID (CS-16):** a `POST /consultations` is sent with a known
  `X-Correlation-Id`; the test asserts the response echoes it, then reads the admin
  audit query for that consultation and asserts **every** resulting row carries the
  same `metadata.correlationId` — proving the ID flows request → service → audit
  (SC-15). It also checks that a missing ID is minted and a malformed one is rejected
  and replaced (no header/log injection).
- **Readiness (CS-17):** `GET /ready` returns 200 with `postgres: up` — the database
  is the dependency that gates readiness.
- **No clinical data in logs (CS-18):** a fast unit test
  (`logging-redaction.spec.ts`) exercises the pino serializers and redaction policy
  directly — asserting the request record is only `id`/`method`/`url` with the query
  string stripped, the response record is only the status code, headers/bodies are
  removed, and the probe endpoints are excluded. This is complemented by the existing
  audit no-clinical-content scan (CS-15). A deterministic unit assertion is used
  rather than scraping a live log stream, which would be brittle.

> **Rate limiting (ADR-0009)** is enforced in dev/prod but its limits are scaled far
> up in the test environment so the concurrency/e2e suites (many requests from one
> IP) are never throttled; the guard still runs. A deterministic 429 test is omitted
> deliberately — it would be timing-dependent — and the limiter is a manual/config
> check.

## Running the tests

```bash
# Unit tests (no database) — fast, always runnable
npm test                                   # all workspaces
npm run test --workspace backend           # backend only

# Integration / e2e — require a real Postgres TEST database.
# A safety guard refuses to run unless DATABASE_URL names a *_test database,
# so your dev data is never truncated.
docker compose up -d db                     # Postgres (host port from .env)
#   one-time: create + migrate a throwaway test DB
#   (psql: CREATE DATABASE vcp_test;)
DATABASE_URL="postgresql://vcp:vcp_dev_password@localhost:5433/vcp_test?schema=public" \
  npx prisma migrate deploy --schema backend/src/prisma/schema.prisma
# A long sweep interval keeps the background claim-TTL tick from racing the
# deterministic CS-8 assertions; the tests drive the sweep directly.
DATABASE_URL="postgresql://vcp:vcp_dev_password@localhost:5433/vcp_test?schema=public" \
  CLAIM_TTL_SWEEP_INTERVAL_SECONDS=3600 \
  npm run test:e2e --workspace backend
```

In CI the e2e job provisions `postgres:16` as a service, materializes `.env`, runs
`prisma migrate deploy`, and then the e2e suite — see `.github/workflows/ci.yml`.

## CI pipeline (Phase 6 — gates enforced)

Phase 5 produced coverage **observe-only**; Phase 6 turns the gates on and adds a
dedicated accessibility + visual job. The pipeline (`.github/workflows/ci.yml`) runs
four jobs in parallel on every PR and on `main`; a red gate blocks the merge (SC-16).

```mermaid
flowchart TB
    pr([PR / push to main]) --> verify & integration & a11y & docker

    subgraph verify [job: verify]
        direction TB
        v1[lint] --> v2[typecheck] --> v3[backend unit] --> v4["frontend test:cov<br/>GATE ≥80% ✅"]
    end
    subgraph integration [job: integration · Postgres]
        direction TB
        i1[prisma migrate deploy] --> i2[unit + e2e with coverage] --> i3[nyc merge] --> i4["nyc check-coverage<br/>GATE ≥90% stmts/lines/fns ✅"]
    end
    subgraph a11y [job: accessibility-visual · Playwright container]
        direction TB
        a1[build + serve stubbed app] --> a2["axe WCAG 2.1 AA + contrast"] --> a3["visual screenshots vs<br/>committed baselines"]
    end
    subgraph docker [job: docker]
        direction TB
        d1[build backend image] --> d2[build frontend image]
    end

    classDef gate fill:#e6f4ea,stroke:#2b7a3d;
    class v4,i4 gate
```

The key Phase 6 change is the two **GATE** steps (green): frontend Vitest coverage in
`verify`, and the merged backend `nyc check-coverage` in `integration` — both now fail
the build on a regression, where Phase 5 only uploaded a report. The
`accessibility-visual` job is new.

## Coverage (CI-enforced — [ADR-0014](adr/0014-coverage-gate-strategy.md))

Targets: **backend ≥ 90%**, **frontend ≥ 80%** (NFR-7 / SC-10 / SC-11). As of Phase 6
these are **gates, not observations** — a drop below threshold fails CI.

- **Backend — merged unit + e2e.** Unit-only coverage is ~13% _by design_: the core
  guarantees (DB-atomic claim, RBAC, real-time, observability) are proven against a real
  Postgres, not mocks. So the gate is computed over the **union** of the unit and
  e2e suites' Istanbul coverage: each runs with coverage (`test:cov:unit`,
  `test:cov:e2e`), a helper merges them into `.nyc_output`, and `nyc check-coverage`
  enforces it. Thresholds: **statements / lines / functions ≥ 90%**; **branches ≥ 65%**
  (the remaining uncovered branches are socket-gateway, health-probe and config/degrade
  paths the integration suite exercises in aggregate — forcing them one-by-one is the
  number-chasing C23 warns against). Run locally with `npm run coverage:combined
--workspace backend` (needs the test DB up). Current: ~94% stmts / ~73%
  branch.
- **Frontend — Vitest v8.** `npm run test:cov --workspace frontend` gates statements /
  lines / functions / branches at **≥ 80%**. Current: ~95% stmts.
- **Exclusions** (excluded, not fake-tested): DI modules, DTO shells, `main.ts`, the
  Prisma seed, and the main-only socket.io CORS adapter.
- **Critical scenarios stay the priority (SC-12):** CS-1 … CS-20 are covered
  regardless of the percentage; the added tests closed real gaps (e.g. summary
  immutability, deactivation guards, room targeting), not vanity lines.

## Accessibility (CI-enforced — [ADR-0015](adr/0015-accessibility-tooling.md))

**WCAG 2.1 AA** on the four critical screens (login, triage queue, consultation room,
summary), verified with **axe** in two tiers plus explicit keyboard and contrast checks
(NFR-6 / SC-13 / C24):

- **Component tier (fast, every PR):** `jest-axe` runs the axe AA ruleset on each
  screen in jsdom; keyboard navigation (tab order, focus, Enter-to-submit) is asserted
  with `user-event`.
- **Browser tier:** `@axe-core/playwright` runs the full A/AA tag set against each
  screen in real Chromium, where axe computes **colour contrast** against the rendered
  layout (jsdom cannot).
- **Token-contrast test:** a deterministic unit test checks every foreground/background
  pair in `styles.css` against 4.5:1. This Phase 6 pass found and fixed real violations
  — `--muted`, the `--urgent` tier colour and the patient badge were below AA and were
  darkened.

## Visual regression (CI-enforced — [ADR-0016](adr/0016-visual-regression.md))

Pixel baselines on the **four critical screens only** (C25), via Playwright
`toHaveScreenshot`. The screens render from a static build with the backend stubbed
(Playwright `page.route` + seeded auth, socket blocked) — deterministic, no
Postgres, no real data.

- **Baselines are container-pinned.** Snapshots differ across operating systems (font
  hinting/anti-aliasing), so they are generated and compared **only** inside the pinned
  `mcr.microsoft.com/playwright` container and committed under
  `frontend/tests/e2e/__screenshots__/`. CI runs the visual job in that same container.
- **Regenerating baselines** (after an intended visual change) — run in-container, never
  from a host OS:

  ```bash
  docker run --rm -v "$PWD":/work -v /work/node_modules -v /work/frontend/node_modules \
    -v /work/backend/node_modules -w /work mcr.microsoft.com/playwright:v1.64.1-noble \
    bash -c "npm ci && cd frontend && npx playwright test visual --update-snapshots"
  ```

  (The anonymous `node_modules` volumes keep the container's Linux install from
  clobbering a host `node_modules`.) Commit the updated PNGs in the same PR.

### Manual / one-time setup

- Install the new dev deps: `npm install` (adds Vitest, Testing Library, jest-axe,
  Playwright, `nyc`).
- Download the Playwright browser for a **local** run: `npx playwright install chromium`
  (CI uses the container image, which already has it).
- **Docker Desktop** must be running for the backend merged-coverage run (needs the
  `vcp_test` DB) and for regenerating visual baselines.
