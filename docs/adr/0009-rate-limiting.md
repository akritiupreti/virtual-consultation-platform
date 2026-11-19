# ADR-0009: Application-level rate limiting

- **Status:** Accepted
- **Date:** 2026-10-15
- **Deciders:** Project owner

## Context

Phase 4 hardens the input surface. Authentication is the abuse-prone endpoint:
credential brute-force and user enumeration both rely on firing many login or
register requests quickly. This ADR records the mechanism that bounds that rate.

## Decision

Add **app-level rate limiting** via `@nestjs/throttler`, enforced by a global guard.

- A generous **global default** (`THROTTLE_LIMIT` requests per `THROTTLE_TTL_SECONDS`)
  applies to every route.
- **Stricter per-route override** for authentication (`POST /auth/login`,
  `POST /auth/register`) via `AUTH_THROTTLE_LIMIT` (default 10/min).
- **Storage.** Counters live in the throttler's in-memory store — the app runs as a
  single instance, so there is nothing to share. Correctness of the core domain
  never depends on the limiter.
- In the **test environment** the limits are scaled far out of the way so the
  concurrency and e2e suites (which fire many requests from one IP) are never
  throttled; the guard still runs, so the code path is exercised.

Failed logins are also **audited** (`LOGIN_FAILURE`, reason code only), so
repeated attempts are visible in the audit trail independently of the limiter.

## Alternatives considered

- **`@nestjs/throttler` (chosen).** First-class NestJS integration, per-route
  overrides, trivial to test.
- **Reverse-proxy / gateway limiting (nginx, API gateway).** Appropriate in a
  hosted deployment, but out of scope for a one-command-local target (ADR-0006) and
  invisible to the application's own tests.
- **Hand-rolled counters.** Reinvents the throttler for no benefit and more bugs.
  Rejected.

## Consequences

- The brute-force surface has a bounded request rate; `429 Too Many Requests`
  joins the documented error model.
- The limiter is in-memory, so its counters reset when the API restarts — acceptable
  for a limit measured in minutes.
- The limits are configuration, not hard-coded, so they can be tuned without code
  changes.
