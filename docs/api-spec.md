# API Specification

The REST surface for the MVP vertical slice (Phase 2). WebSocket event contracts
for live queue/room updates are added in Phase 3. Authorization for every endpoint
derives from the single [authorization matrix](authorization-matrix.md) and the
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

| Status             | Meaning in this API                                                           |
| ------------------ | ----------------------------------------------------------------------------- |
| `400 Bad Request`  | Validation failure (missing/extra field, bad enum, consent not granted)       |
| `401 Unauthorized` | Missing/invalid/expired token                                                 |
| `403 Forbidden`    | Role or ownership not permitted (authorization matrix)                        |
| `404 Not Found`    | Consultation/summary does not exist (or hidden from a non-participant)        |
| `409 Conflict`     | Illegal state transition, lost claim race, or active-consultation cap reached |

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

| Method & path                       | Roles | Guard                                      | Body           | Success                                      |
| ----------------------------------- | ----- | ------------------------------------------ | -------------- | -------------------------------------------- |
| `POST /consultations`               | P     | —                                          | intake (below) | `201` my-consultation view (QUEUED)          |
| `GET /consultations/queue`          | N,D   | —                                          | —              | `200` minimal pre-claim list (priority→FIFO) |
| `GET /consultations/mine`           | P     | owner                                      | —              | `200` own consultations + "N ahead"          |
| `GET /consultations/:id`            | P,N,D | participant                                | —              | `200` full detail + intake                   |
| `POST /consultations/:id/claim`     | N,D   | `state=QUEUED` (DB-atomic)                 | —              | `200` CLAIMED · `409` if already claimed     |
| `POST /consultations/:id/start`     | N,D   | assigned · `state=CLAIMED` · under cap     | —              | `200` IN_SESSION · `409` cap/again           |
| `POST /consultations/:id/complete`  | N,D   | assigned · `state=IN_SESSION`              | —              | `200` ENDED                                  |
| `POST /consultations/:id/cancel`    | P     | owner · `state∈{REQUESTED,QUEUED,CLAIMED}` | —              | `200` CANCELLED                              |
| `PATCH /consultations/:id/priority` | N,D   | `state=QUEUED`                             | `{ priority }` | `200 { id, state, priority }`                |

**Intake body** (`POST /consultations`): `chiefComplaint` (3–2000), `symptomCategory`
(controlled list), `onsetDuration`, `severity` (1–5), `consent` (**must be `true`**),
optional `priority` (`ROUTINE`\|`URGENT`\|`EMERGENCY`), `history`, `medications`.

The **pre-claim queue item** exposes only: `priority`, `symptomCategory`, `severity`,
a truncated `complaintSummary`, `enqueuedAt`, `waitingSeconds` — never patient
identity or attachments (data minimization, FR-7/C7).

## Messaging (clinical content — admin denied)

| Method & path                      | Roles | Guard                            | Body                | Success              |
| ---------------------------------- | ----- | -------------------------------- | ------------------- | -------------------- |
| `POST /consultations/:id/messages` | P,N,D | participant · `state=IN_SESSION` | `{ body }` (1–4000) | `201` message        |
| `GET /consultations/:id/messages`  | P,N,D | participant                      | —                   | `200` messages (asc) |

## Summary (clinical content — admin denied)

| Method & path                              | Roles | Guard                                                 | Body                   | Success                      |
| ------------------------------------------ | ----- | ----------------------------------------------------- | ---------------------- | ---------------------------- |
| `POST /consultations/:id/summary`          | N,D   | assigned · `state∈{IN_SESSION,ENDED}` · not finalized | `{ content }` (1–8000) | `201` draft                  |
| `POST /consultations/:id/summary/finalize` | D     | `state=ENDED`                                         | —                      | `200` finalized → SUMMARIZED |
| `GET /consultations/:id/summary`           | P,N,D | participant; patient only when finalized              | —                      | `200` summary                |

A finalized summary is **immutable**; corrections become append-only addendums
(Phase 4). Attempting to re-draft a finalized summary returns `409`.

## Audit (admin only)

| Method & path        | Roles | Body | Success                                    |
| -------------------- | ----- | ---- | ------------------------------------------ |
| `GET /audit?limit=N` | A     | —    | `200` recent events (default 200, max 500) |

Audit records carry **who / what / when** only — never message bodies, attachment
contents, or summary text (invariants 5 & 6).

### Audit event catalogue (Phase 2 subset)

`CONSULTATION_REQUESTED`, `CONSULTATION_ENQUEUED`, `CONSULTATION_CLAIMED`,
`CONSULTATION_STARTED`, `CONSULTATION_COMPLETED`, `CONSULTATION_CANCELLED`,
`PRIORITY_CHANGED`, `MESSAGE_SENT`, `SUMMARY_DRAFTED`, `SUMMARY_FINALIZED`.

The full catalogue and log schema are formalized in `audit-logging.md` (Phase 4).

## Health

| Method & path | Auth | Success                           |
| ------------- | ---- | --------------------------------- |
| `GET /health` | —    | `200 { status: "ok", timestamp }` |
