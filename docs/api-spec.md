# API Specification

The REST surface for the MVP vertical slice (Phase 2) plus the **WebSocket event
contracts** for live queue/room updates (Phase 3 — see [§WebSocket API](#websocket-api-phase-3)).
Authorization for every endpoint _and every WebSocket room_ derives from the single
[authorization matrix](authorization-matrix.md) and the
[state machine](state-machine.md); see the request pipeline in
[architecture.md §2](architecture.md).

## Conventions

- **Base URL:** `http://localhost:3000` (configurable; the frontend uses `VITE_API_URL`).
- **Auth:** send `Authorization: Bearer <accessToken>` (short-lived JWT, [ADR-0005](adr/0005-authn-authz.md)).
  Everything except `POST /auth/*` and `GET /health` requires it.
- **Body / responses:** JSON. Request bodies are validated (`class-validator`); unknown
  fields are rejected (`400`).
- **IDs:** UUID v4. Path ids are validated; a malformed id is `400`.

### Error model

| Status                  | Meaning in this API                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `400 Bad Request`       | Validation failure (missing/extra field, bad enum, consent not granted)                                             |
| `401 Unauthorized`      | Missing/invalid/expired token, or the account is not active                                                         |
| `403 Forbidden`         | Role or ownership not permitted (authorization matrix)                                                              |
| `404 Not Found`         | Consultation/summary/user does not exist (or hidden from a non-participant)                                         |
| `409 Conflict`          | Illegal state transition, lost claim race, active-consultation cap, or deactivating a user who is in a live session |
| `413 Payload Too Large` | Request body exceeds the configured size cap                                                                        |
| `429 Too Many Requests` | Rate limit exceeded (the auth endpoints are limited; [ADR-0009](adr/0009-rate-limiting.md))                         |

Error bodies follow Nest's shape: `{ "statusCode", "message", "error" }` where
`message` may be a string or an array of validation messages.

## Authentication

| Method & path         | Auth | Body                  | Success                     | Notes                                                  |
| --------------------- | ---- | --------------------- | --------------------------- | ------------------------------------------------------ |
| `POST /auth/register` | —    | `{ email, password }` | `201 { accessToken, user }` | Always creates a **PATIENT** (no privilege escalation) |
| `POST /auth/login`    | —    | `{ email, password }` | `200 { accessToken, user }` | Deactivated users cannot log in                        |
| `GET /auth/me`        | any  | —                     | `200 { id, email, role }`   | —                                                      |

## Consultations

Roles: **P**atient · **N**urse · **D**octor · **A**dmin. "Guard" is the state +
ownership condition checked after the role gate.

| Method & path                        | Roles | Guard                                                    | Body           | Success                                      |
| ------------------------------------ | ----- | -------------------------------------------------------- | -------------- | -------------------------------------------- |
| `POST /consultations`                | P     | —                                                        | intake (below) | `201` my-consultation view (QUEUED)          |
| `GET /consultations/queue`           | N,D   | —                                                        | —              | `200` minimal pre-claim list (priority→FIFO) |
| `GET /consultations/mine`            | P     | owner                                                    | —              | `200` own consultations + "N ahead"          |
| `GET /consultations/assigned`        | N,D   | own claims (`claimedBy` = caller)                        | —              | `200` minimal list of the caller's cases     |
| `GET /consultations/pending-signoff` | D     | `state=ENDED` + drafted-unfinalized summary              | —              | `200` minimal sign-off worklist              |
| `GET /consultations/signed-off`      | D     | own sign-offs (`summary.finalizedBy` = caller)           | —              | `200` minimal sign-off history (ADR-0023)    |
| `GET /consultations/:id`             | P,N,D | participant · _or_ doctor while `state=ENDED` (sign-off) | —              | `200` full detail + intake                   |
| `POST /consultations/:id/claim`      | N,D   | `state=QUEUED` (DB-atomic)                               | —              | `200` CLAIMED · `409` if already claimed     |
| `POST /consultations/:id/start`      | N,D   | assigned · `state=CLAIMED` · under cap                   | —              | `200` IN_SESSION · `409` cap/again           |
| `POST /consultations/:id/complete`   | N,D   | assigned · `state=IN_SESSION`                            | —              | `200` ENDED                                  |
| `POST /consultations/:id/cancel`     | P     | owner · `state∈{REQUESTED,QUEUED,CLAIMED}`               | —              | `200` CANCELLED                              |
| `PATCH /consultations/:id/priority`  | N,D   | `state=QUEUED`                                           | `{ priority }` | `200 { id, state, priority }`                |

**Intake body** (`POST /consultations`): `chiefComplaint` (3–2000), `symptomCategory`
(controlled list), `onsetDuration`, `severity` (1–5), `consent` (**must be `true`**),
optional `priority` (`ROUTINE`\|`URGENT`\|`EMERGENCY`), `history`, `medications`.

The **pre-claim queue item** exposes only: `priority`, `symptomCategory`, `severity`,
a truncated `complaintSummary`, `enqueuedAt`, `waitingSeconds` — never patient
identity or the full narrative (data minimization, FR-7/C7).

The **list views** are deliberately minimal (invariant 6) — a short complaint label,
never the full narrative or summary text:

| View                       | Fields                                                                                                                                                                                    |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mine` (patient)           | `id`, `state`, `priority`, `createdAt`, `complaintSummary` (their own, ≤100 chars), `position` (QUEUED only), `summaryAvailable`                                                          |
| `assigned` (clinician)     | `id`, `state`, `priority`, `symptomCategory`, `complaintSummary`, `claimedAt`/`startedAt`/`endedAt`, `summaryDrafted`, `summaryFinalized`                                                 |
| `pending-signoff` (doctor) | `id`, `priority`, `symptomCategory`, `complaintSummary`, `endedAt`, `draftedBy`, `draftedAt`                                                                                              |
| `signed-off` (doctor)      | `id`, `priority`, `symptomCategory`, `complaintSummary`, `endedAt`, `finalizedAt`, `draftedBy` — never the summary text; open the summary via `GET /consultations/:id/summary` (ADR-0020) |

`summaryDrafted: false` on an `ENDED` case is what the clinician UI flags as "Write
the summary": without a saved draft the case cannot reach the sign-off worklist
([ADR-0021](adr/0021-explicit-summary-save.md)).

## Messaging (clinical content — admin denied)

| Method & path                      | Roles | Guard                            | Body                | Success              |
| ---------------------------------- | ----- | -------------------------------- | ------------------- | -------------------- |
| `POST /consultations/:id/messages` | P,N,D | participant · `state=IN_SESSION` | `{ body }` (1–4000) | `201` message        |
| `GET /consultations/:id/messages`  | P,N,D | participant                      | —                   | `200` messages (asc) |

## Summary (clinical content — admin denied)

| Method & path                              | Roles | Guard                                                                                                             | Body                   | Success                      |
| ------------------------------------------ | ----- | ----------------------------------------------------------------------------------------------------------------- | ---------------------- | ---------------------------- |
| `POST /consultations/:id/summary`          | N,D   | assigned · `state∈{IN_SESSION,ENDED}` · not finalized                                                             | `{ content }` (1–8000) | `201` draft                  |
| `POST /consultations/:id/summary/finalize` | D     | `state=ENDED` (any doctor, incl. nurse-run cases)                                                                 | —                      | `200` finalized → SUMMARIZED |
| `GET /consultations/:id/summary`           | P,N,D | participant (patient only when finalized), _or_ doctor while `state=ENDED` (sign-off), _or_ the finalizing doctor | —                      | `200` summary                |

A finalized summary is **immutable** (FR-13) — once signed, its content is never
changed. Attempting to re-draft a finalized summary returns `409`.

## Users (admin only)

Admin user management and the account-deactivation lifecycle (FR-14, FR-23/24/25).
Admin-only (matrix `MANAGE_USERS`); nothing here exposes clinical content.

| Method & path                | Roles | Guard                               | Success                                             |
| ---------------------------- | ----- | ----------------------------------- | --------------------------------------------------- |
| `GET /users`                 | A     | —                                   | `200` accounts (id, email, role, status, createdAt) |
| `POST /users/:id/deactivate` | A     | not self · not in an active session | `200` user · `409` while the user is in a session   |
| `POST /users/:id/reactivate` | A     | —                                   | `200` user                                          |

- Deactivation is a **soft** state change (never a delete). A deactivated user cannot
  log in, any already-issued token is rejected on the next request (status re-checked
  from the DB), and their live sockets are dropped.
- A user who is the patient or the assigned clinician of an `IN_SESSION`
  consultation cannot be deactivated: the request is `409` until the session ends
  ([ADR-0010](adr/0010-deactivation-during-session.md)). A clinician who has only
  claimed a case can be deactivated; the claim-start TTL returns that case to the
  queue.
- An admin cannot deactivate **their own** account (`400`); deactivating an already-
  deactivated user (or reactivating an active one) is `409`.

<a id="audit-admin-only"></a>

## Audit (admin only)

Filterable and paginated (FR-15). Filters compose (AND). Unknown query params are
rejected (`400`).

| Method & path | Roles | Query params                                                                                            | Success                                                   |
| ------------- | ----- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `GET /audit`  | A     | `actorId`, `eventType`, `consultationId`, `from`, `to` (ISO-8601), `limit` (≤200, default 50), `offset` | `200 { items, total, limit, offset }` (most recent first) |

Audit records carry **who / what / when** only — never message bodies or summary
text (invariants 5 & 6). The full catalogue and log
schema are in [audit-logging.md](audit-logging.md).

### Audit event catalogue

`LOGIN_SUCCESS`, `LOGIN_FAILURE`, `USER_DEACTIVATED`, `USER_REACTIVATED`,
`CONSULTATION_REQUESTED`, `CONSULTATION_ENQUEUED`, `CONSULTATION_CLAIMED`,
`CONSULTATION_REQUEUED`, `CONSULTATION_STARTED`, `CONSULTATION_COMPLETED`,
`CONSULTATION_CANCELLED`, `PRIORITY_CHANGED`, `MESSAGE_SENT`, `SUMMARY_DRAFTED`,
`SUMMARY_FINALIZED`
(single source: `backend/src/audit/audit-events.ts`).

`CONSULTATION_REQUEUED` (claim-start TTL) is a **system** event (no actor) with
metadata `{ reason, ttlSeconds, previousClaimedBy }` — who/what/when only, never clinical content. The admin audit
screen shows actor ids as the account email (from `GET /users`) and filters by
event, actor, consultation and date range. The full catalogue with metadata and the
log schema are in [audit-logging.md](audit-logging.md).

## WebSocket API (Phase 3)

Live triage-queue and consultation-room updates over **socket.io** at the same
origin as the REST API (`VITE_API_URL`)
([ADR-0004](adr/0004-realtime-websockets.md)/[0007](adr/0007-realtime-implementation.md)).
Events are **signals**: the server stays authoritative and clients reconcile real
state via the REST endpoints above.

### Connection & handshake

- Connect with the JWT in the socket handshake: `io(BASE_URL, { auth: { token } })`
  (a `Bearer` `Authorization` header is also accepted).
- The token is verified on connect with the same `JWT_SECRET` as REST. A
  missing/invalid/expired token is **disconnected** immediately.
- On connect the server auto-joins the user to their personal room `user:<id>`.

### Rooms & authorization

Room membership is granted only after the same authorization check as REST
(role → state → ownership). No payload carries clinical content beyond what the
room's members are already permitted to read (data minimization, invariants 3 & 6).

| Room                | Who may join                                                    | Authorized by                                                                                |
| ------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `queue`             | Nurse / Doctor                                                  | matrix `VIEW_QUEUE`                                                                          |
| `consultation:<id>` | That consultation's participants (and a doctor during sign-off) | matrix `VIEW_CONSULTATION`                                                                   |
| `user:<id>`         | That user only (auto-joined)                                    | the authenticated identity                                                                   |
| `signoff`           | Every doctor (auto-joined on connect)                           | the verified JWT role is `DOCTOR` ([ADR-0022](adr/0022-live-summary-and-signoff-signals.md)) |

Admins can connect (to use REST admin features) but are **refused** every clinical
room — separation of duties holds over WebSockets.

### Client → server

Each returns an ack `{ ok: boolean, error?: 'unauthorized'|'forbidden'|'not_found'|'bad_request' }`.

| Event                | Payload              | Effect                                    |
| -------------------- | -------------------- | ----------------------------------------- |
| `subscribe:queue`    | —                    | Join the `queue` room (clinicians only)   |
| `join:consultation`  | `{ consultationId }` | Join `consultation:<id>` if a participant |
| `leave:consultation` | `{ consultationId }` | Leave the room                            |

### Server → client

| Event                  | Payload                                                          | Trigger                                                                                 |
| ---------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `queue:updated`        | `{ reason, consultationId? }`                                    | enqueue · priority change · claim · requeue · complete · cancel (FR-18/C18)             |
| `consultation:updated` | `{ consultationId, state }`                                      | any state change; to the room and the patient's and assigned clinician's personal rooms |
| `message:created`      | `{ consultationId, message: { id, senderId, body, createdAt } }` | a new message (private room only; body is allowed here)                                 |
| `summary:updated`      | `{ consultationId, reason }`                                     | draft saved · finalized · case ended; to `signoff` + the assignee (ADR-0022)            |
| `position:updated`     | `{ consultationId, state, position }`                            | a patient's live "N ahead" changed (C2/FR-4)                                            |

`queue:updated` `reason` ∈ `enqueued | priority_changed | claimed | requeued | completed | cancelled | state_changed`.
`summary:updated` `reason` ∈ `drafted | finalized | ended`.

`summary:updated` is a **content-free signal**: no summary text rides it, and it is never sent
to the patient (a draft is not theirs to see). Recipients reconcile through the REST
endpoints above, which apply the authorization matrix as usual.

### Reconnection

- socket.io auto-reconnects; on reconnect the client re-authenticates, re-emits
  its `subscribe`/`join`, and **reconciles from REST**. Connection loss never
  changes server state ([state-machine.md](state-machine.md)).

## Health

| Method & path | Auth | Success                           |
| ------------- | ---- | --------------------------------- |
| `GET /health` | —    | `200 { status: "ok", timestamp }` |
