# API Specification

The REST surface for the MVP vertical slice (Phase 2) plus the **WebSocket event
contracts** for live queue/room updates (Phase 3 — see [§WebSocket API](#websocket-api-phase-3)).
Authorization for every endpoint _and every WebSocket room_ derives from the single
[authorization matrix](authorization-matrix.md) and the
[state machine](state-machine.md); see the request pipeline in
[architecture.md §2](architecture.md).

## Conventions

- **Base URL:** `http://localhost:3000` (configurable; the frontend uses `VITE_API_URL`).
- **Auth:** send `Authorization: Bearer <accessToken>` (short-lived JWT, [ADR-0006](adr/0006-authn-authz.md)).
  Everything except `POST /auth/*` and `GET /health` requires it.
- **Body / responses:** JSON. Request bodies are validated (`class-validator`); unknown
  fields are rejected (`400`).
- **IDs:** UUID v4. Path ids are validated; a malformed id is `400`.

### Error model

| Status                       | Meaning in this API                                                                                |
| ---------------------------- | -------------------------------------------------------------------------------------------------- |
| `400 Bad Request`            | Validation failure (missing/extra field, bad enum, consent not granted, missing file)              |
| `401 Unauthorized`           | Missing/invalid/expired token, or the account is not active                                        |
| `403 Forbidden`              | Role or ownership not permitted (authorization matrix); invalid/expired signed URL                 |
| `404 Not Found`              | Consultation/summary/user does not exist (or hidden from a non-participant)                        |
| `409 Conflict`               | Illegal state transition, lost claim race, active-consultation cap, or attachment count reached    |
| `413 Payload Too Large`      | Request body or uploaded file exceeds the configured size cap                                      |
| `415 Unsupported Media Type` | Upload is not an allowed JPEG/PNG/PDF (checked by magic bytes, not just the declared type)         |
| `429 Too Many Requests`      | Rate limit exceeded (auth and upload endpoints are limited; [ADR-0011](adr/0011-rate-limiting.md)) |

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
| `GET /consultations/signed-off`      | D     | own sign-offs (`summary.finalizedBy` = caller)           | —              | `200` minimal sign-off history (ADR-0029)    |
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
identity or attachments (data minimization, FR-7/C7).

The **list views** are deliberately minimal (invariant 6) — a short complaint label,
never the full narrative or summary text:

| View                       | Fields                                                                                                                                                                                    |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mine` (patient)           | `id`, `state`, `priority`, `createdAt`, `complaintSummary` (their own, ≤100 chars), `position` (QUEUED only), `summaryAvailable`                                                          |
| `assigned` (clinician)     | `id`, `state`, `priority`, `symptomCategory`, `complaintSummary`, `claimedAt`/`startedAt`/`endedAt`, `summaryDrafted`, `summaryFinalized`, `summaryChangesRequested`                      |
| `pending-signoff` (doctor) | `id`, `priority`, `symptomCategory`, `complaintSummary`, `endedAt`, `draftedBy`, `draftedAt`, `changesRequested` (returned to the drafter, not yet revised)                               |
| `signed-off` (doctor)      | `id`, `priority`, `symptomCategory`, `complaintSummary`, `endedAt`, `finalizedAt`, `draftedBy` — never the summary text; open the summary via `GET /consultations/:id/summary` (ADR-0023) |

`summaryDrafted: false` on an `ENDED` case is what the clinician UI flags as "Write
the summary": without a saved draft the case cannot reach the sign-off worklist
([ADR-0026](adr/0026-explicit-summary-save.md)).

## Messaging (clinical content — admin denied)

| Method & path                      | Roles | Guard                            | Body                | Success              |
| ---------------------------------- | ----- | -------------------------------- | ------------------- | -------------------- |
| `POST /consultations/:id/messages` | P,N,D | participant · `state=IN_SESSION` | `{ body }` (1–4000) | `201` message        |
| `GET /consultations/:id/messages`  | P,N,D | participant                      | —                   | `200` messages (asc) |

## Attachments (clinical content — admin denied)

Attachments are stored in a local object store and reached only via short-lived,
user-scoped **signed URLs** that still pass the authorization matrix on every fetch
([ADR-0007](adr/0007-attachment-storage.md)). Admins are denied (separation of
duties). Allowed types: **JPEG/PNG/PDF** (validated by magic bytes), ≤ 10 MB/file,
with a per-consultation count cap.

| Method & path                                         | Roles | Guard                                                                                  | Body                               | Success                                                              |
| ----------------------------------------------------- | ----- | -------------------------------------------------------------------------------------- | ---------------------------------- | -------------------------------------------------------------------- |
| `POST /consultations/:id/attachments`                 | P,N,D | participant · `state=IN_SESSION`                                                       | `multipart/form-data` field `file` | `201` attachment metadata                                            |
| `GET /consultations/:id/attachments`                  | P,N,D | participant                                                                            | —                                  | `200` list + per-item `downloadUrl` + `expiresAt`                    |
| `DELETE /consultations/:id/attachments/:attachmentId` | P     | patient owner · **own upload** · `state=IN_SESSION` (re-checked atomically)            | —                                  | `204` · `403` other's file/role · `409` after the session (ADR-0028) |
| `GET /attachments/:id/download?token=`                | —     | **signed token** (user-scoped, short-lived); re-runs the matrix + active-account check | —                                  | `200` file stream (`inline`)                                         |

- The upload is rate-limited ([ADR-0011](adr/0011-rate-limiting.md)); a wrong/spoofed
  type is `415`, an over-size file `413`, and exceeding the per-consultation count
  `409`.
- The download route is authorized by the **token itself** (so it works as a plain
  URL), not a bearer JWT: the token binds `{attachmentId, userId, exp}`, carries no
  PII/clinical data, and the handler re-loads the user, confirms the account is
  active, and re-runs the matrix — an admin or non-participant is refused even with a
  valid link; a tampered/expired/mismatched token is `403`.

## Summary (clinical content — admin denied)

| Method & path                                     | Roles | Guard                                                                                                             | Body                   | Success                                  |
| ------------------------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------- | ---------------------- | ---------------------------------------- |
| `POST /consultations/:id/summary`                 | N,D   | assigned · `state∈{IN_SESSION,ENDED}` · not finalized                                                             | `{ content }` (1–8000) | `201` draft                              |
| `POST /consultations/:id/summary/finalize`        | D     | `state=ENDED` (any doctor, incl. nurse-run cases)                                                                 | —                      | `200` finalized → SUMMARIZED             |
| `POST /consultations/:id/summary/request-changes` | D     | `state=ENDED` · draft not finalized (any doctor); returns draft to drafter, stays ENDED                           | `{ note? }` (1–2000)   | `200` draft (+ changes-requested marker) |
| `POST /consultations/:id/summary/addendum`        | N,D   | clinician · `state=SUMMARIZED`                                                                                    | `{ content }` (1–8000) | `201` summary + addenda                  |
| `GET /consultations/:id/summary`                  | P,N,D | participant (patient only when finalized), _or_ doctor while `state=ENDED` (sign-off), _or_ the finalizing doctor | —                      | `200` summary + addenda                  |

A finalized summary is **immutable**; corrections are **append-only addendums**
(FR-13, C5) — the summary content itself is never mutated. Attempting to re-draft a
finalized summary returns `409`, as does an addendum before finalize. The summary
view includes an `addenda` array (oldest first).

## Users (admin only)

Admin user management and the account-deactivation lifecycle (FR-14, FR-23/24/25).
Admin-only (matrix `MANAGE_USERS`); nothing here exposes clinical content.

| Method & path                | Roles | Guard    | Success                                             |
| ---------------------------- | ----- | -------- | --------------------------------------------------- |
| `GET /users`                 | A     | —        | `200` accounts (id, email, role, status, createdAt) |
| `POST /users/:id/deactivate` | A     | not self | `200` user + `reassignedConsultationIds`            |
| `POST /users/:id/reactivate` | A     | —        | `200` user                                          |

- Deactivation is a **soft** state change (never a delete). A deactivated user cannot
  log in, any already-issued token is rejected on the next request (status re-checked
  from the DB), and their live sockets are dropped.
- Deactivating a **clinician mid-session** reassigns each of their `CLAIMED`/
  `IN_SESSION` cases back to the queue (`CONSULTATION_REASSIGNED`) and notifies the
  patient via real-time fan-out ([ADR-0012](adr/0012-mid-session-reassignment.md)).
- An admin cannot deactivate **their own** account (`400`); deactivating an already-
  deactivated user (or reactivating an active one) is `409`.

<a id="audit-admin-only"></a>

## Audit (admin only)

Filterable and paginated (FR-15). Filters compose (AND). Unknown query params are
rejected (`400`).

| Method & path | Roles | Query params                                                                                            | Success                                                   |
| ------------- | ----- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `GET /audit`  | A     | `actorId`, `eventType`, `consultationId`, `from`, `to` (ISO-8601), `limit` (≤200, default 50), `offset` | `200 { items, total, limit, offset }` (most recent first) |

Audit records carry **who / what / when** only — never message bodies, attachment
contents/filenames, or summary text (invariants 5 & 6). The full catalogue and log
schema are in [audit-logging.md](audit-logging.md).

### Audit event catalogue

`LOGIN_SUCCESS`, `LOGIN_FAILURE`, `USER_DEACTIVATED`, `USER_REACTIVATED`,
`CONSULTATION_REQUESTED`, `CONSULTATION_ENQUEUED`, `CONSULTATION_CLAIMED`,
`CONSULTATION_REQUEUED`, `CONSULTATION_REASSIGNED`, `CONSULTATION_STARTED`,
`CONSULTATION_COMPLETED`, `CONSULTATION_CANCELLED`, `PRIORITY_CHANGED`,
`MESSAGE_SENT`, `ATTACHMENT_UPLOADED`, `ATTACHMENT_ACCESSED`, `ATTACHMENT_DELETED`, `SUMMARY_DRAFTED`,
`SUMMARY_FINALIZED`, `SUMMARY_CHANGES_REQUESTED`, `SUMMARY_ADDENDUM_ADDED`
(single source: `backend/src/audit/audit-events.ts`).

`CONSULTATION_REQUEUED` (claim-start TTL) and `CONSULTATION_REASSIGNED`
(deactivation) are **system** events (no actor) with metadata such as `{ reason,
previousClaimedBy }` — who/what/when only, never clinical content. The admin audit
screen shows actor ids as the account email (from `GET /users`) and filters by
event, actor, consultation and date range. The full catalogue with metadata and the
log schema are in [audit-logging.md](audit-logging.md).

## WebSocket API (Phase 3)

Live triage-queue and consultation-room updates over **socket.io** at the same
origin as the REST API (`VITE_API_URL`), fanned out across instances by Redis
([ADR-0004](adr/0004-redis-responsibilities.md)/[0005](adr/0005-realtime-websockets.md)/[0009](adr/0009-realtime-implementation.md)).
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
| `signoff`           | Every doctor (auto-joined on connect)                           | the verified JWT role is `DOCTOR` ([ADR-0027](adr/0027-live-summary-and-signoff-signals.md)) |

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

| Event                       | Payload                                                          | Trigger                                                                                           |
| --------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `queue:updated`             | `{ reason, consultationId? }`                                    | enqueue · priority change · claim · requeue · complete · cancel (FR-18/C18)                       |
| `consultation:updated`      | `{ consultationId, state }`                                      | any state change; to the room and the patient's and assigned clinician's personal rooms           |
| `message:created`           | `{ consultationId, message: { id, senderId, body, createdAt } }` | a new message (private room only; body is allowed here)                                           |
| `summary:changes-requested` | `{ consultationId, note? }`                                      | a doctor returned a draft to its author to revise; to the drafter's personal room only (ADR-0024) |
| `summary:updated`           | `{ consultationId, reason }`                                     | draft saved · changes requested · finalized · case ended; to `signoff` + the assignee (ADR-0027)  |
| `attachment:created`        | `{ consultationId }`                                             | a file was shared; to the consultation room, whose members re-fetch the list (ADR-0027)           |
| `attachment:removed`        | `{ consultationId }`                                             | the patient removed a file they shared; to the consultation room (ADR-0028)                       |
| `position:updated`          | `{ consultationId, state, position }`                            | a patient's live "N ahead" changed (C2/FR-4)                                                      |
| `presence:updated`          | `{ consultationId, participants: [{ userId, online }] }`         | a participant connected/disconnected/joined/left                                                  |

`queue:updated` `reason` ∈ `enqueued | priority_changed | claimed | requeued | reassigned | completed | cancelled | state_changed`.
`summary:updated` `reason` ∈ `drafted | changes_requested | finalized | ended`.

`summary:updated` and `attachment:created`/`removed` are **content-free signals**: no summary
text, review note, filename or file rides them, and `summary:updated` is never sent
to the patient (a draft is not theirs to see). Recipients reconcile through the REST
endpoints above, which apply the authorization matrix as usual.

### Reconnection & degradation

- socket.io auto-reconnects; on reconnect the client re-authenticates, re-emits
  its `subscribe`/`join`, and **reconciles from REST**. Connection loss never
  changes server state ([state-machine.md](state-machine.md)).
- If `REDIS_URL` is unset/unreachable the gateway degrades to a single-instance
  in-memory adapter and in-memory presence; all events still flow within one
  instance and core flows are unaffected.

## Health

| Method & path | Auth | Success                           |
| ------------- | ---- | --------------------------------- |
| `GET /health` | —    | `200 { status: "ok", timestamp }` |
