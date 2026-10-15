# ADR-0007: Attachment storage & signed-URL access

- **Status:** Accepted
- **Date:** 2026-10-15
- **Deciders:** Project owner

## Context

Patients may share attachments (JPEG/PNG/PDF) in a consultation
([C4](../amrit-feedback-responses.md), FR-5). Attachments are **clinical content**,
so access must obey the same boundary as messages and summaries: only the two
participants (patient owner + assigned clinician), **never** an admin (invariant
3), scoped to the specific consultation, and exposed only through **short-lived,
scoped signed URLs** with **no PII/clinical data in the URL** (NFR-2, invariant 6).
The storage choice must keep the project **one-command-local** (ADR-0008) and add
no cloud accounts.

The `ATTACHMENT` entity already exists in the schema (filename, mimeType,
sizeBytes, storageKey, uploadedBy), so the open decisions are **where the bytes
live** and **how a signed URL enforces our access rule**.

## Decision

Store attachment bytes in a **local filesystem object store**, served through the
application behind **app-issued signed URLs**.

- **Storage:** files are written under a configurable, git-ignored directory
  (`ATTACHMENT_STORAGE_DIR`, default `./var/attachments`), named by an **opaque
  random key** (UUID) — never the client filename — which removes path-traversal
  and collision risk. The DB row holds the metadata and the storage key.
- **Upload:** `POST /consultations/:id/attachments` (multipart). Participant-only
  (matrix `UPLOAD_ATTACHMENT`) and only while `IN_SESSION` (mirrors messaging). The
  real content type is **sniffed from the file's magic bytes** and must match the
  declared type; non-JPEG/PNG/PDF is `415`. Per-file size (`ATTACHMENT_MAX_BYTES`,
  10 MB) and per-consultation count (`ATTACHMENT_MAX_PER_CONSULTATION`) are capped.
- **Signed URL:** listing attachments mints, per attachment, a short-lived
  (`ATTACHMENT_URL_TTL_SECONDS`, default 5 min) HMAC token over
  `{attachmentId, userId, exp}`. The token is opaque — it carries no filename,
  patient id, or clinical data, so nothing sensitive lands in a query string.
- **Download:** `GET /attachments/:id/download?token=…` verifies the token
  (signature + expiry + attachment match), **re-loads the bound user, confirms the
  account is still active, and re-runs the full authorization matrix** (role →
  state → ownership). An admin or non-participant is refused **even with a valid
  link** — the signed URL never bypasses the matrix.
- **Audit:** upload (`ATTACHMENT_UPLOADED`) and access (`ATTACHMENT_ACCESSED`)
  record id/type/size only — never the filename or bytes (invariants 5 & 6).

**No Prisma migration is required** — the `ATTACHMENT` table already carries every
field; signed URLs are computed, not stored.

## Alternatives considered

- **Local filesystem + app-issued signed URLs** (chosen) — keeps one-command-local,
  routes **every** fetch through the authorization pipeline, and still demonstrates
  the signed-URL pattern. Strongest fit for "participant-only, never admin,
  state-aware".
- **MinIO / S3 with native presigned URLs.** S3-compatible and realistic, but a
  presigned URL **grants access to anyone holding the link** for its lifetime — it
  cannot express our rule (participant-only, never admin, re-checked per request).
  We would have to proxy downloads through the app anyway, at which point the bucket
  adds a container, credentials, and failure modes for no access-control benefit.
  Rejected for this capstone; noted as the scale-out path if object storage is ever
  needed in production.
- **Bytes in PostgreSQL (`bytea`).** Simple and transactional, but bloats the
  primary DB and its backups and couples large binary I/O to the system of record.
  Rejected.

## Consequences

- Access control for attachments is identical to messages/summaries and is tested
  the same way (admin denied; non-participant denied; signed-URL scoping/expiry) —
  see [testing-strategy.md](../testing-strategy.md) and [security-privacy.md](../security-privacy.md).
- The local store is a directory the Phase 5 app container will mount as a volume;
  until then it lives under the backend workspace and is git-ignored.
- A signed URL is user-bound and short-lived, so a leaked link expires quickly and
  still cannot be used by an admin or a different account.
- The sniff-and-match validation means a spoofed `Content-Type` cannot smuggle in a
  disallowed file type.
