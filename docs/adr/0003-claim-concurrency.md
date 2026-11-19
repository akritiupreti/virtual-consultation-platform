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
UPDATE consultation
   SET state = 'CLAIMED', claimed_by = :actor, claimed_at = now(), version = version + 1
 WHERE id = :id AND state = 'QUEUED' AND claimed_by IS NULL;
```

The winner is the transaction whose update affects **1 row**; a `0 row` result
means someone else already claimed it → respond `409 Conflict`.

## Alternatives considered

- **DB atomic conditional update / optimistic version** (chosen) — no extra
  infrastructure, correct across instances, simple to test.
- **Application-level lock / in-memory mutex** — fails across multiple instances
  and is racy; rejected (the reviewer specifically favoured DB-level handling).
- **External distributed lock service** — works but adds a dependency and failure modes for a
  guarantee Postgres already provides for this case.

## Consequences

- Correctness does not depend on application coordination.
- Directly testable: fire concurrent claims, assert exactly one success.
- The `version` column also supports optimistic concurrency on other updates.
