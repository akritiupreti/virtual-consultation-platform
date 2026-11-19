# ADR-0010: No deactivation during an active session

- **Status:** Accepted
- **Date:** 2026-10-15
- **Deciders:** Project owner

## Context

Deactivation is a soft state change ([C12](../amrit-feedback-responses.md), FR-23):
a deactivated user cannot log in, and any token they already hold stops working.
The hard edge case is **deactivating someone in the middle of a consultation**
(FR-24). If the clinician — or the patient — disappears mid-session, the other
person is left in a room with no one to talk to, and the case is stranded in
`IN_SESSION` on an account that can no longer act.

We need a rule that never strands a case, keeps the state machine small, and is
easy to reason about.

## Decision

**An admin cannot deactivate a user who is currently in an active session.**

- "Active session" means a consultation in `IN_SESSION` where the user is the
  patient or the assigned clinician.
- The rule is enforced **inside the `UPDATE` itself**, not as a separate check
  before it: `UPDATE users SET status='DEACTIVATED' WHERE id=:id AND
status='ACTIVE' AND no IN_SESSION consultation exists for them`. If a session
  starts at the same moment, the database decides — the update either matches the
  row or it does not. Zero rows ⇒ **`409 Conflict`** ("try again after the session
  ends"); nothing changes and nothing is audited.
- A clinician who has only **claimed** a case (not started it) _can_ be
  deactivated. The existing claim-start TTL sweeper ([ADR-0008](0008-claim-start-ttl.md))
  returns that case to the queue within minutes, and the patient keeps their
  original place in line.
- On success: the status change is audited **`USER_DEACTIVATED`** (who/what/when
  only) and the user's live sockets are dropped at once.
- **No new state and no new transition** are needed: the state machine is
  unchanged.

## Alternatives considered

- **Refuse during an active session** (chosen). One condition on one `UPDATE`;
  reuses the claim-TTL sweeper for claimed-but-not-started cases; the admin gets a
  clear message and simply retries after the session.
- **Pause the session and send the case back to the queue.** Never blocks the
  admin, but needs a new `IN_SESSION → QUEUED` transition, its own audit event and
  real-time fan-out, and leaves the patient mid-conversation with a stranger who
  picks the case up next. More moving parts for a rare event. Rejected.
- **A dedicated `PAUSED` state.** Even more explicit, but adds an enum value, a
  migration, new transitions and new UI states. Rejected as scope.

## Consequences

- A consultation in progress is never interrupted by an admin action; both people
  can finish it.
- An urgent deactivation (e.g. a compromised account) waits for the session to end.
  For a capstone this is acceptable; a production system could add an "end the
  session now" admin action in front of this rule.
- The state machine stays exactly `Requested → Queued → Claimed → In Session →
Ended → Summarized` (plus cancel and the TTL requeue).
- Proven by [testing-strategy.md](../testing-strategy.md) (deactivation e2e): both
  participants of an `IN_SESSION` case get `409`; once the session ends the
  clinician can be deactivated and can no longer act.
