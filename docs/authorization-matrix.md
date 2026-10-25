# Authorization Matrix

Authorization is **role- _and_ state-aware** and enforced server-side from this
single source of truth. "Ownership/guard" captures the conditions beyond role.

## Authorization boundary — clinical content

The strongest boundary is **separation of duties**: admins operate the system but
can never read clinical content.

```mermaid
flowchart LR
    subgraph Clinical [Clinical content]
        M[Messages]
        At[Attachments]
        Su[Summaries]
    end
    Patient([Patient]) -->|own consultation only| Clinical
    Clinician([Nurse / Doctor]) -->|assigned consultation only| Clinical
    Admin([Admin]) -. BLOCKED .-x Clinical
    Admin -->|users + audit log only| Ops[User mgmt · Audit log]
```

## Matrix

Legend: ✅ allowed · ⚠️ allowed with guard · ❌ denied.

| Action                             | Patient | Nurse | Doctor | Admin | Ownership / guard                                             |
| ---------------------------------- | :-----: | :---: | :----: | :---: | ------------------------------------------------------------- |
| Register / log in                  |   ✅    |  ✅   |   ✅   |  ✅   | —                                                             |
| Submit request                     |   ✅    |  ❌   |   ❌   |  ❌   | —                                                             |
| View own queue position            |   ⚠️    |  ❌   |   ❌   |  ❌   | Own consultation                                              |
| View triage queue                  |   ❌    |  ✅   |   ✅   |  ❌   | —                                                             |
| View pre-claim case info (minimal) |   ❌    |  ✅   |   ✅   |  ❌   | Minimal fields only                                           |
| View pending sign-off worklist     |   ❌    |  ❌   |   ✅   |  ❌   | ENDED + drafted-unfinalized; minimal fields                   |
| Claim case                         |   ❌    |  ⚠️   |   ⚠️   |  ❌   | `state=QUEUED`, under claim cap                               |
| Start consultation                 |   ❌    |  ⚠️   |   ⚠️   |  ❌   | `actor = claimed_by`, `state=CLAIMED`                         |
| Send / read messages               |   ⚠️    |  ⚠️   |   ⚠️   |  ❌   | Participant of that consultation                              |
| Upload attachment                  |   ⚠️    |  ⚠️   |   ⚠️   |  ❌   | Participant; `state=IN_SESSION`                               |
| View / download attachment         |   ⚠️    |  ⚠️   |   ⚠️   |  ❌   | Participant; short-lived user-scoped signed URL               |
| End consultation                   |   ❌    |  ⚠️   |   ⚠️   |  ❌   | `actor = claimed_by`, `state=IN_SESSION`                      |
| Draft summary                      |   ❌    |  ⚠️   |   ⚠️   |  ❌   | Assigned clinician                                            |
| Finalize summary                   |   ❌    |  ❌   |   ⚠️   |  ❌   | `role=DOCTOR`, `state=ENDED`                                  |
| Add summary addendum               |   ❌    |  ⚠️   |   ⚠️   |  ❌   | Clinician; `state=SUMMARIZED` (append-only)                   |
| View summary                       |   ⚠️    |  ⚠️   |   ⚠️   |  ❌   | Participant, **or any doctor while `state=ENDED`** (sign-off) |
| View clinical content              |   ⚠️    |  ⚠️   |   ⚠️   |  ❌   | **Admin always denied**                                       |
| Manage / deactivate users          |   ❌    |  ❌   |   ❌   |  ✅   | —                                                             |
| View audit log                     |   ❌    |  ❌   |   ❌   |  ✅   | Excludes clinical content                                     |

## Enforcement rules

1. **Deny by default.** An action absent from the matrix for a role is denied.
2. **Role + state + ownership** are all checked; passing one is not enough
   (e.g. a doctor who is not `claimed_by` cannot start that consultation).
3. **Guards share the transition registry** in [state-machine.md](state-machine.md)
   so state checks are never duplicated.
4. **Admin ≠ clinical access** is a hard, tested invariant, not a configuration.
5. **Signed URLs never bypass the matrix.** An attachment download URL is a
   short-lived, user-scoped token, but the download handler still re-loads the bound
   user, confirms the account is active, and re-runs this matrix (role → state →
   ownership) on every fetch — so an admin or non-participant is refused even with a
   valid link ([ADR-0007](adr/0007-attachment-storage.md)).
6. **Deactivated accounts are denied everything.** Account status is re-checked
   against the database on every REST request and WebSocket handshake, so a token
   issued before deactivation stops working immediately (FR-25).
7. **Doctor sign-off read window.** Because `FINALIZE_SUMMARY` is doctor-only and
   not participant-scoped, a doctor may also **read** a case (consultation detail +
   summary) while it is **awaiting sign-off** — i.e. in the `FINALIZE_SUMMARY`
   transition's source state (`ENDED`) with a drafted, unfinalized summary — even if
   they did not run it. This closes the read/finalize asymmetry for nurse-run cases
   and is scoped by rule 3 (states come from the registry); admin is never a doctor,
   so separation of duties is untouched ([ADR-0020](adr/0020-doctor-signoff-of-nurse-run-cases.md)).
