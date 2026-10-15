# ADR-0012: Mid-session reassignment on clinician deactivation

- **Status:** Accepted
- **Date:** 2026-10-15
- **Deciders:** Project owner

## Context

Deactivation is a soft state change ([C12](../amrit-feedback-responses.md), FR-23).
The hard edge case is **a clinician deactivated mid-session** (FR-24): their active
consultation must be _paused_ and _requeued/reassigned_, and the patient notified —
the case cannot be stranded on an account that can no longer act.

The state machine has a `REQUEUE` transition (`CLAIMED → QUEUED`) for the claim-TTL
sweeper, but **no transition out of `IN_SESSION` back to the queue**. We must decide
how to model "pause and reassign" without stranding the case or quietly corrupting
the state machine.

## Decision

Model it as a new **system transition `REASSIGN` (`CLAIMED` or `IN_SESSION` →
`QUEUED`)** in the central transition registry, driven by the deactivation handler.

- `REASSIGN` is added to the transition registry (the single source of truth,
  invariant 1), not hard-coded in the handler. It covers both a claimed-not-started
  case and an active session.
- On deactivation of a `NURSE`/`DOCTOR`, every case they hold in `CLAIMED` or
  `IN_SESSION` is returned to the queue with the **same atomic conditional `UPDATE`**
  used by claim and the TTL sweeper: `… SET state='QUEUED', claimed_by=NULL,
claimed_at=NULL, started_at=NULL, version=version+1 WHERE id=:id AND claimed_by=:id
AND state IN ('CLAIMED','IN_SESSION')`. A race with the clinician's own last action
  resolves in the DB (exactly one update affects the row).
- `enqueued_at` is left unchanged, so the patient **keeps their place in line**
  rather than going to the back of the queue.
- Each reassignment is audited **`CONSULTATION_REASSIGNED`** (system actor; metadata
  `{ reason: 'clinician_deactivated', previousClaimedBy }` — who/what/when only), and
  the existing real-time fan-out notifies the queue and the patient (state back to
  `QUEUED`, fresh position). The deactivated user's live sockets are then dropped.
- **No `PAUSED` state** is introduced, so **no enum change and no Prisma migration**.

## Alternatives considered

- **`REASSIGN → QUEUED`, reusing the atomic requeue + fan-out** (chosen). Keeps the
  state set small, reuses proven concurrency and real-time code, needs no migration,
  and leaves the case immediately claimable by another clinician.
- **A dedicated `PAUSED` state.** Arguably more explicit ("this was interrupted"),
  but it is an enum change (migration), adds transitions (`PAUSED → CLAIMED/QUEUED`)
  and UI states, and offers no behavioural benefit over returning to `QUEUED` for
  the MVP. Rejected as scope; could be revisited if "resume with the same clinician"
  were ever required.
- **Direct reassignment to a specific clinician.** Requires choosing a target
  (load-balancing, availability) — out of scope. Returning to the shared queue lets
  the normal claim flow pick it up.

## Consequences

- A deactivated clinician's work is never stranded; the patient is picked up again
  through the standard queue and is notified live (reconciling from REST on
  reconnect if offline).
- The state machine gains one system transition; [state-machine.md](../state-machine.md)
  and its diagram are updated to show `IN_SESSION → QUEUED (reassign)`.
- Deactivation is auditable end-to-end: `USER_DEACTIVATED` plus a
  `CONSULTATION_REASSIGNED` per affected case.
- Proven by [testing-strategy.md](../testing-strategy.md) (deactivation e2e):
  mid-session deactivation returns the case to `QUEUED`, clears assignment, and
  writes the audit rows.
