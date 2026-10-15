# ADR-0011: Application-level rate limiting

- **Status:** Accepted
- **Date:** 2026-10-15
- **Deciders:** Project owner

## Context

Phase 4 hardens the input surface. Two endpoints are abuse-prone: authentication
(credential brute-force / user enumeration) and attachment upload (resource
exhaustion). [ADR-0004](0004-redis-responsibilities.md) already lists **rate
limiting** as a Redis responsibility, so adding it is executing an existing
decision — this ADR records the concrete mechanism.

## Decision

Add **app-level rate limiting** via `@nestjs/throttler`, enforced by a global guard.

- A generous **global default** (`THROTTLE_LIMIT` requests per `THROTTLE_TTL_SECONDS`)
  applies to every route.
- **Stricter per-route overrides**: authentication (`POST /auth/login`,
  `POST /auth/register`) via `AUTH_THROTTLE_LIMIT` (default 10/min), and attachment
  upload via `UPLOAD_THROTTLE_LIMIT` (default 30/min).
- **Storage.** The throttler's in-memory store is the default. The documented
  scale-out path is a **Redis-backed store** (ADR-0004), which makes limits shared
  across API instances; absent Redis it degrades to per-instance limits — the same
  graceful-degradation stance as the socket adapter and presence. Correctness of the
  core domain never depends on the limiter.
- In the **test environment** the limits are scaled far out of the way so the
  concurrency and e2e suites (which fire many requests from one IP) are never
  throttled; the guard still runs, so the code path is exercised.

Failed logins are also **audited** (`LOGIN_FAILURE`, reason code only), so
repeated attempts are visible in the audit trail independently of the limiter.

## Alternatives considered

- **`@nestjs/throttler` (chosen).** First-class NestJS integration, per-route
  overrides, pluggable storage (incl. Redis), trivial to test.
- **Reverse-proxy / gateway limiting (nginx, API gateway).** Appropriate in a
  hosted deployment, but out of scope for a one-command-local target (ADR-0008) and
  invisible to the application's own tests.
- **Hand-rolled Redis counters.** Reinvents the throttler for no benefit and more
  bugs. Rejected.

## Consequences

- Brute-force and upload-flood surfaces have a bounded request rate; `429 Too Many
Requests` joins the documented error model.
- Locally and in CI the limiter is in-memory (per instance); production would set a
  Redis store to share limits across instances.
- The limits are configuration, not hard-coded, so they can be tuned without code
  changes.
