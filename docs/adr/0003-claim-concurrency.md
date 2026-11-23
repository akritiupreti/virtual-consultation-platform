# ADR-0003: Claim concurrency strategy

- **Status:** Accepted
- **Date:** 2026-10-12
- **Deciders:** Project owner

## Context

Two clinicians may try to claim the same queued consultation simultaneously.
Exactly one must win, deterministically, even under race conditions and across
multiple API instances.

## Decision

Resolve the claim **in the database** with an **atomic conditional update**:

```sql
UPDATE consultations
   SET state = 'CLAIMED', claimed_by = :actor, claimed_at = now(), version = version + 1
 WHERE id = :id AND state = 'QUEUED' AND claimed_by IS NULL;
```

The `WHERE` clause is the guard: PostgreSQL locks the row while it updates it, so
a second, concurrent `UPDATE` re-checks `state` and `claimed_by` after the first
commits and no longer matches. The winner is the transaction whose update affects
**1 row**; a `0 row` result means someone else already claimed it → respond
`409 Conflict`.

## Alternatives considered

- **DB atomic conditional update on `state` + `claimed_by`** (chosen) — no extra
  infrastructure, correct across instances, simple to test.
- **Application-level lock / in-memory mutex** — fails across multiple instances
  and is racy; rejected (the reviewer specifically favoured DB-level handling).
- **External distributed lock service** — works but adds a dependency and failure modes for a
  guarantee Postgres already provides for this case.

## Consequences

- Correctness does not depend on application coordination.
- Directly testable: fire concurrent claims, assert exactly one success.
- The same conditional-update pattern guards every other state change (start,
  end, cancel, the claim-timeout requeue): each `UPDATE` names the state it
  expects, so a case that has moved on returns `0 rows` → `409`.
- The `version` column is only a change counter, bumped on every state change. It
  is not part of any `WHERE` clause, so the claim does not depend on it.
