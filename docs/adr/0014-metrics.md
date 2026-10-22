# ADR-0014: Metrics approach

- **Status:** Accepted
- **Date:** 2026-10-15
- **Deciders:** Project owner

## Context

Phase 5 asks for basic metrics — request throughput/latency plus a couple of
domain signals (queue depth, active consultations) — exposed on an endpoint
(NFR-5). The project's deployment target is local Docker Compose (ADR-0008), so the
approach should be demonstrable there without external accounts, while still being
the industry-standard shape a real operator would recognise.

The same privacy rule as logging applies: metrics are **aggregate counts/timings
only** — who/what/when — never PII or clinical content, and never high-cardinality
labels that could encode identity.

## Decision

Expose **Prometheus** metrics via **`prom-client`** on an unauthenticated
**`GET /metrics`** endpoint in the Prometheus text exposition format.

- **Request metrics** — a histogram `http_request_duration_seconds` labelled by
  `method`, `route` and `status`, fed by a global Nest interceptor. Its `_count`
  series doubles as the request counter. The label is the **matched route template**
  (`/consultations/:id/claim`), never the concrete path, so IDs never land in a
  label and cardinality stays bounded.
- **Domain metrics** — gauges `vcp_queue_depth` (QUEUED consultations) and
  `vcp_active_consultations` (IN_SESSION), read from **PostgreSQL** — the system of
  record (ADR-0002) — on each scrape via an async `collect` callback. Reading on
  scrape means the numbers are always the authoritative counts with no event
  bookkeeping to drift out of sync.
- **Default process metrics** (event-loop lag, memory, GC) via
  `collectDefaultMetrics`, on a per-instance registry.
- **Unauthenticated**, like `/health`: it exposes only aggregates and is reached by
  a scraper on the local Compose network. Request logging for it is suppressed.

## Alternatives considered

- **Prometheus / prom-client** (chosen) — the de-facto standard; a pull model that
  needs no external account, demonstrable locally, and instantly recognisable.
- **OpenTelemetry metrics SDK** — vendor-neutral and powerful, but heavier to set
  up and more than a solo capstone needs; the Prometheus exporter would end up in
  the same place. Over-engineered for the scope.
- **StatsD / hosted APM (Datadog, New Relic)** — push-based and feature-rich, but
  require an agent or an account and recurring cost, conflicting with ADR-0008.
- **Derive domain gauges from events instead of the DB** — avoids a per-scrape
  query but reintroduces a second source of truth that can drift; rejected for the
  same reason the queue is read straight from Postgres (invariant: DB is
  authoritative). The scrape query is a cheap `COUNT` on an indexed column.

## Consequences

- Adds the `prom-client` dependency.
- `/metrics` gives request throughput/latency and live queue/active-session gauges
  that a Prometheus scraper (or `curl`) can read — demonstrable under Compose.
- The per-scrape `COUNT` on consultations is trivial at this scale; if it ever
  isn't, the gauges can move to event-driven updates without changing the endpoint.
- No authentication on `/metrics` is acceptable for local Compose; exposing it
  publicly would warrant network-level restriction (noted as future work in
  [deployment.md](../deployment.md)).
- Detail and diagrams live in [observability.md](../observability.md).
