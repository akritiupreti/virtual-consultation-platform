# ADR-0017: Audit-log query indexing

- **Status:** Accepted
- **Date:** 2026-10-23
- **Deciders:** Project owner

## Context

The Phase 7 performance pass profiled the hot read paths against a realistically
sized database (80,000 `audit_logs` rows). The admin audit query (FR-15,
[audit.service.ts](../../backend/src/audit/audit.service.ts)) always orders by
`created_at DESC` and is typically opened **unfiltered** ("show me the latest
events"), optionally filtered by `actor_id`, `event_type`, `consultation_id` or a
time range.

`EXPLAIN (ANALYZE, BUFFERS)` showed two plans that do not scale (full evidence in
[performance.md](../performance.md)):

- **Unfiltered, newest-first:** a **parallel sequential scan of the whole table**
  plus a top-N heap sort (13 ms, 1,711 buffers) — there was no index on
  `created_at`, so the cost grows with the size of the audit log.
- **Filtered by `event_type`, newest-first:** `event_type` is low-cardinality (a
  handful of values), so the filter matched ~10,000 rows which were then **all read
  and sorted** to return the newest 50 (3.5 ms, 1,679 buffers).

The remaining filters (`consultation_id`, `actor_id`) are high-cardinality — they
match tens of rows — so the existing single-column indexes plus a tiny sort were
already sub-millisecond and are not a problem.

A countervailing force: `audit_logs` is the most **append-heavy** table in the
system — a row is written on essentially every auditable action (invariant 5) — so
every added index is paid for on each insert. Indexes here must earn their keep.

## Decision

Add two indexes to `audit_logs`, and **replace** (not supplement) the bare
`event_type` index:

- **`@@index([createdAt])`** — serves the common unfiltered "latest events" view as a
  backward index scan, bounded to the page size.
- **`@@index([eventType, createdAt])`** — serves the `event_type` filter **and** its
  `created_at DESC` ordering in a single index scan; because `event_type` is the
  leading column it also answers a bare `event_type` equality lookup, so the previous
  `@@index([eventType])` is dropped rather than kept alongside it.

Leave `@@index([consultationId])` and `@@index([actorId])` as they are (high-cardinality
equality filters, already fast), and make **no** change to the `consultations`
indexes. Shipped as migration `20261023021229_perf_audit_log_indexes`.

## Alternatives considered

- **The two indexes above, event_type one replaced** (chosen) — net **one** extra
  index on the write path, turning both pathological plans into bounded index reads
  (unfiltered 13 ms → 0.08 ms; event_type 3.5 ms → 0.12 ms).
- **Keep the single-column `event_type` index and add a composite** — redundant: the
  composite already serves the equality lookup, so this is pure extra write cost.
- **Also add `(consultation_id, created_at)` and `(actor_id, created_at)`** — rejected
  on evidence: those filters match few rows and are already sub-millisecond; the
  indexes would add write cost for no measurable read gain.
- **A direction-matched queue index `(state, priority DESC, enqueued_at ASC)`** —
  considered as part of the same pass and rejected: the queue sort is over the
  already-filtered `QUEUED` set (bounded, 0.6 ms) and does not justify another index
  on the hot `consultations` table (see [performance.md §4](../performance.md)).
- **Optimise the pagination `COUNT(*)`** — the exact total is one bounded index-only
  scan (~7 ms) on a low-frequency, human-driven screen; accepted as-is, with an
  approximate count noted as the honest next step only if the log grows by orders of
  magnitude.

## Consequences

- The admin audit query no longer degrades as the log grows: the default view and the
  `event_type` filter are bounded index reads instead of full scans.
- One additional index is maintained on the append-heavy `audit_logs` table; this was
  weighed explicitly and judged worth it for the default view.
- No application code changed for the indexing — the `ORDER BY created_at DESC` and
  filters were already there; the planner simply has the right index now. (The
  separate, code-level `getMine` N+1 fix from the same pass is documented in
  [performance.md §3.3](../performance.md).)
- The invariants are untouched: PostgreSQL remains authoritative (ADR-0002), and no
  PII or clinical content is in any index key (invariant 6) — the keys are a
  timestamp and an event-type label.
