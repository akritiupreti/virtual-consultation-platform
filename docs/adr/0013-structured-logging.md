# ADR-0013: Structured logging & correlation-ID strategy

- **Status:** Accepted
- **Date:** 2026-10-15
- **Deciders:** Project owner

## Context

Phase 5 requires operability: logs that a machine can parse and that let a single
request be followed end-to-end across the REST API, the domain services and the
WebSocket gateway (NFR-5, SC-15). Two implementation choices are genuinely open and
not covered by an existing ADR:

1. **How we log** — the default NestJS logger emits unstructured, human-only text
   with no request context.
2. **How a request is correlated** — nothing ties the log lines, the response, and
   the audit rows of one request together.

The hard constraint is the Phase 4 privacy boundary (NFR-2, invariant 6): **no
PII or clinical content may ever reach the logs** — not message bodies, not intake
text, not attachment names, not tokens. Logs are who/what/when only.

## Decision

Use **`pino`** (via **`nestjs-pino`**) for structured **JSON** logging, and carry a
per-request **correlation ID** through an `AsyncLocalStorage` (ALS) store.

- **nestjs-pino replaces the Nest logger** (`app.useLogger`), so existing
  `Logger` calls (e.g. the Redis provider, the claim-TTL sweeper) are reformatted
  as JSON with no code change.
- **Correlation ID.** An Express middleware runs **first** (before Helmet, the body
  parsers and pino-http): it reuses a well-formed caller-supplied `X-Correlation-Id`
  or mints a UUID, echoes it on the **response header** (SC-15), and runs the rest of
  the request inside the ALS store. `genReqId` reuses that ID as pino's `req.id`, so
  every request-scoped log line carries the same `correlationId`.
- **Propagation beyond REST.** Domain services and the `AuditService` read the ID
  from the ALS — so audit rows are stamped with the request's `correlationId`
  (in `metadata`, no schema migration). The **WebSocket gateway** assigns one ID per
  socket (from the handshake or minted) and runs each handler inside the store; the
  **claim-TTL sweeper** runs each sweep under a fresh ID. A log line is therefore
  never without a correlation ID, whatever triggered it.
- **Privacy by construction.** Minimal pino serializers emit only `req.id`,
  `method`, `url` (**query string stripped** — it can carry identifiers) and
  `statusCode`. Request/response **headers and bodies are removed** by redaction as
  defence in depth. Probe/metrics endpoints are excluded from request logging to
  keep the signal clean. This policy is pinned by a unit test
  (`test/logging-redaction.spec.ts`, CS-18).

## Alternatives considered

- **Keep the default Nest logger** — human-readable but unstructured and
  context-free; cannot satisfy traceability (SC-15) or machine aggregation. Rejected.
- **Winston** — capable and popular, but heavier and slower than pino, and its
  Nest integration is less direct. pino's speed and first-class `nestjs-pino`
  (with built-in `pino-http` and ALS request context) fit better.
- **Correlation via a NestJS request-scoped provider** instead of ALS — request
  scoping bubbles through the DI graph, hurts performance and does not reach the WS
  gateway or the background sweeper. ALS is transport-agnostic and zero-ceremony.
- **A dedicated `correlationId` column on `AuditLog`** instead of `metadata` — more
  queryable, but needs a migration and schema churn for a trace token. Deferred;
  `metadata` is already returned verbatim by the admin query (FR-15). Revisit if
  correlation becomes a first-class audit filter.

## Consequences

- Adds dependencies: `nestjs-pino`, `pino`, `pino-http`, and `pino-pretty` (dev,
  for readable local logs; raw JSON in production via `LOG_PRETTY=false`).
- One correlation ID now spans a request's logs, its response header, and its audit
  rows — a request is traceable end-to-end (SC-15 / CS-16).
- The no-PII/clinical policy is enforced in code (serializers + redaction) and
  guarded by a test, so the Phase 4 privacy boundary holds in the log stream (SC-9).
- New env: `LOG_LEVEL`, `LOG_PRETTY`, `CORRELATION_ID_HEADER` (see `.env.example`).
- Detail and diagrams live in [observability.md](../observability.md).
