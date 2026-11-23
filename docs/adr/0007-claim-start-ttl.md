# ADR-0007: Claim-start TTL via a DB-authoritative sweeper

- **Status:** Accepted
- **Date:** 2026-10-15
- **Deciders:** Project owner

## Context

Claiming a case assigns it but does not start it (FR-12). A clinician who claims but never starts must not be able to park a case
indefinitely: a claim not started within a **start TTL** auto-requeues
(`CLAIMED → QUEUED`), clears `claimed_by`, is audited, and notifies subscribers
(the `REQUEUE` transition already defined in [state-machine.md](../state-machine.md)).

The open question is the **mechanism** that fires the requeue. It must respect the
invariants: PostgreSQL is authoritative, exactly one requeue must take effect even
under races, and it must survive an API restart.

## Decision

Requeue overdue claims with a **periodic, database-authoritative sweeper**.

- A scheduled job (via `@nestjs/schedule`, every `CLAIM_TTL_SWEEP_INTERVAL_SECONDS`)
  asks PostgreSQL for the overdue set: `state = CLAIMED`, `started_at IS NULL`, and
  `claimed_at < now() - CLAIM_START_TTL_SECONDS`.
- Each overdue case is requeued with the **same atomic conditional `UPDATE`**
  pattern the claim uses (invariant 2): `UPDATE … SET state='QUEUED',
claimed_by=NULL, claimed_at=NULL, version=version+1 WHERE id=:id AND
state='CLAIMED' AND started_at IS NULL`. A race with a legitimate `start`
  therefore resolves in the database: whichever commits first wins; the sweeper's
  update matches zero rows if the clinician started in time, and `start` matches
  zero rows if the sweeper requeued first.
- Because the requeue itself is atomic, **two API instances sweeping concurrently
  is safe** — only one update affects the row. No lock is required for correctness.
- Every requeue writes a **`CONSULTATION_REQUEUED`** audit event (invariant 5) and
  triggers the real-time broadcasts (queue changed, the patient's new position,
  the consultation's new state).
- `enqueued_at` is left unchanged on requeue, so a requeued case regains its
  original priority/FIFO standing rather than going to the back of its tier.

## Alternatives considered

- **Per-claim in-memory timer (`setTimeout` on claim).** Simple, but the timer
  lives in one process's memory: it is lost on restart/crash and does not exist on
  other instances, so a claim made on instance A would never be swept if A
  restarts. It also makes a process's memory the de-facto authority on a pending
  transition. Rejected — fragile and at odds with "PostgreSQL is authoritative".
- **Postgres `pg_cron` / scheduled SQL.** Keeps it in the DB, but adds an extension
  and moves domain logic out of the application and its audit path. Rejected for a
  solo capstone; the app-level sweeper is easier to test and audit.

## Consequences

- The TTL is **self-healing**: the sweeper reconciles from the DB on every tick, so
  a restart mid-TTL simply picks the overdue case up on the next sweep.
- Requeue latency is bounded by the sweep interval (seconds), which is acceptable
  for triage and is configurable.
- The sweep method is exposed so tests can invoke it deterministically (seed a
  `CLAIMED` case with a back-dated `claimed_at`, sweep once, assert `QUEUED` +
  `CONSULTATION_REQUEUED`) — see [testing-strategy.md](../testing-strategy.md) CS-8.
- If no one is connected, the broadcast after a requeue simply reaches no one; the
  requeue + audit (the parts that matter) happen regardless.
