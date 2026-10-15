# Consultation State Machine

The consultation lifecycle is the **single source of truth** for which actions are
legal. All transitions are enforced server-side from one central transition
registry — never ad hoc in individual handlers.

## States

| State        | Meaning                                              |
| ------------ | ---------------------------------------------------- |
| `REQUESTED`  | Patient submitted intake; not yet validated/enqueued |
| `QUEUED`     | In the live triage queue, awaiting a clinician       |
| `CLAIMED`    | Assigned to a clinician, not yet started             |
| `IN_SESSION` | Active consultation (messaging/attachments)          |
| `ENDED`      | Clinician completed the consultation                 |
| `SUMMARIZED` | A doctor finalized the clinical summary (terminal)   |
| `CANCELLED`  | Cancelled before a session began (terminal)          |

## Diagram

```mermaid
stateDiagram-v2
    [*] --> REQUESTED: patient submits
    REQUESTED --> QUEUED: intake valid + consent + priority set
    REQUESTED --> CANCELLED: patient cancels
    QUEUED --> CLAIMED: clinician claims (DB-atomic)
    QUEUED --> CANCELLED: patient cancels
    CLAIMED --> IN_SESSION: claiming clinician starts
    CLAIMED --> QUEUED: start TTL expires (auto-requeue)
    CLAIMED --> QUEUED: clinician deactivated (reassign)
    CLAIMED --> CANCELLED: patient cancels (before start)
    IN_SESSION --> ENDED: claiming clinician completes
    IN_SESSION --> QUEUED: clinician deactivated mid-session (reassign)
    ENDED --> SUMMARIZED: doctor finalizes summary
    SUMMARIZED --> [*]
    CANCELLED --> [*]
```

## Transition table (allowed)

| From → To             | Actor              | Guard                                                                               |
| --------------------- | ------------------ | ----------------------------------------------------------------------------------- |
| REQUESTED → QUEUED    | System             | Intake valid, consent granted, priority assigned                                    |
| REQUESTED → CANCELLED | Patient (owner)    | Before enqueue                                                                      |
| QUEUED → CLAIMED      | Nurse / Doctor     | `state=QUEUED AND claimed_by IS NULL` (atomic); actor under claim cap               |
| QUEUED → CANCELLED    | Patient (owner)    | Not yet claimed                                                                     |
| CLAIMED → IN_SESSION  | Claiming clinician | `actor = claimed_by`; within start TTL                                              |
| CLAIMED → QUEUED      | System             | Start TTL expired; clears `claimed_by`; audited (`REQUEUE`)                         |
| CLAIMED → QUEUED      | System             | Assigned clinician deactivated; clears `claimed_by`; audited (`REASSIGN`)           |
| CLAIMED → CANCELLED   | Patient (owner)    | Before session starts                                                               |
| IN_SESSION → ENDED    | Claiming clinician | `actor = claimed_by`                                                                |
| IN_SESSION → QUEUED   | System             | Assigned clinician deactivated mid-session; clears assignment; audited (`REASSIGN`) |
| ENDED → SUMMARIZED    | Doctor             | `role = DOCTOR`; summary finalized                                                  |

## Invalid transitions (explicitly rejected)

| Attempt                                | Why rejected            | Expected response |
| -------------------------------------- | ----------------------- | ----------------- |
| QUEUED → IN_SESSION                    | Must be claimed first   | `409 Conflict`    |
| CLAIMED → IN_SESSION by a non-claimer  | `actor ≠ claimed_by`    | `403 Forbidden`   |
| Second clinician claims a CLAIMED case | Already claimed         | `409 Conflict`    |
| ENDED → IN_SESSION                     | No reopening            | `409 Conflict`    |
| ENDED → SUMMARIZED by a nurse          | Finalize is doctor-only | `403 Forbidden`   |
| SUMMARIZED → *                         | Terminal state          | `409 Conflict`    |
| Any transition after CANCELLED         | Terminal state          | `409 Conflict`    |

## Exception / edge-case handling

- **Claim timeout:** a `CLAIMED` case not started within the start TTL is
  auto-requeued (`CLAIMED → QUEUED`), `claimed_by` cleared, event audited, queue
  subscribers notified. Implemented in Phase 3 by a DB-authoritative sweeper
  ([ADR-0010](adr/0010-claim-start-ttl.md)) and audited as `CONSULTATION_REQUEUED`.
- **Clinician deactivated mid-session:** a `CLAIMED` or `IN_SESSION` case held by
  the deactivated clinician is paused and returned to the queue via the `REASSIGN`
  system transition (→ `QUEUED`, clears `claimed_by`/`started_at`, keeps the
  original `enqueued_at` so the patient keeps their place), audited as
  `CONSULTATION_REASSIGNED`, and the patient is notified via the real-time fan-out
  (FR-24; [ADR-0012](adr/0012-mid-session-reassignment.md)). Implemented in Phase 4
  by the account-deactivation lifecycle, reusing the atomic conditional-update
  pattern of the claim/TTL sweeper.
- **Connection loss in session:** the state is unchanged server-side; clients
  reconcile on reconnect from the server's authoritative state.

## Implementation note

The allowed-transition table is encoded once (a transition registry keyed by
`state × action`). Both the API layer and the authorization check read from it,
so there is a single place that defines what is legal — no duplicated logic.
