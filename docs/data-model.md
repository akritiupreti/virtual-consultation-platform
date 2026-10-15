# Data Model

The durable system of record is **PostgreSQL** (via Prisma). Redis holds only
ephemeral/real-time state (presence, pub/sub, cached positions) — never the source
of truth. See [ADR-0002](adr/0002-postgresql-system-of-record.md) and
[ADR-0004](adr/0004-redis-responsibilities.md).

## Entity–relationship diagram

```mermaid
erDiagram
    USER ||--o{ CONSULTATION : "requests (patient)"
    USER ||--o{ CONSULTATION : "claims (clinician)"
    CONSULTATION ||--|| INTAKE : has
    CONSULTATION ||--o{ MESSAGE : contains
    CONSULTATION ||--o{ ATTACHMENT : contains
    CONSULTATION ||--o| SUMMARY : has
    SUMMARY ||--o{ ADDENDUM : "corrected by"
    USER ||--o{ MESSAGE : sends
    USER ||--o{ AUDIT_LOG : "acts in"
    CONSULTATION ||--o{ AUDIT_LOG : "subject of"

    USER {
        uuid id PK
        string email UK
        string password_hash
        enum role "PATIENT|NURSE|DOCTOR|ADMIN"
        enum status "ACTIVE|DEACTIVATED"
        timestamp created_at
    }
    CONSULTATION {
        uuid id PK
        uuid patient_id FK
        uuid claimed_by FK "nullable"
        enum state "REQUESTED|QUEUED|CLAIMED|IN_SESSION|ENDED|SUMMARIZED|CANCELLED"
        enum priority "ROUTINE|URGENT|EMERGENCY"
        int version "optimistic lock"
        timestamp enqueued_at
        timestamp claimed_at
        timestamp started_at
        timestamp ended_at
    }
    INTAKE {
        uuid id PK
        uuid consultation_id FK UK
        string chief_complaint
        string symptom_category
        string onset_duration
        int severity "1-5"
        timestamp consent_at
        string history "nullable"
        string medications "nullable"
    }
    MESSAGE {
        uuid id PK
        uuid consultation_id FK
        uuid sender_id FK
        text body
        timestamp created_at
    }
    ATTACHMENT {
        uuid id PK
        uuid consultation_id FK
        uuid uploaded_by FK
        string filename
        string mime_type
        int size_bytes
        string storage_key
        timestamp created_at
    }
    SUMMARY {
        uuid id PK
        uuid consultation_id FK UK
        uuid drafted_by FK
        uuid finalized_by FK "nullable, DOCTOR"
        text content
        timestamp finalized_at "nullable"
    }
    ADDENDUM {
        uuid id PK
        uuid summary_id FK
        uuid author_id FK
        text content
        timestamp created_at
    }
    AUDIT_LOG {
        uuid id PK
        uuid actor_id FK "nullable"
        string event_type
        uuid consultation_id FK "nullable"
        jsonb metadata "no clinical content"
        timestamp created_at
    }
```

## Key modeling decisions

- **One role per user** via an enum keeps authorization simple; nurse vs doctor
  differences are expressed in the [authorization matrix](authorization-matrix.md).
- **Claim concurrency** relies on `state` + `claimed_by` + a `version` column; the
  claim is an atomic conditional `UPDATE` (see [ADR-0003](adr/0003-claim-concurrency.md)).
- **The queue is derived**, not a separate table: it is the set of `QUEUED`
  consultations ordered by `priority` then `enqueued_at`. Positions may be cached
  in Redis for fast reads, but Postgres remains authoritative.
- **Summary immutability:** a finalized `SUMMARY` is never edited; corrections are
  appended as `ADDENDUM` rows, preserving an auditable record.
- **Attachments** store an **opaque `storage_key`** (a server-generated UUID naming
  the file in the local object store), never the client filename, and never the bytes
  in the DB. Access is only via short-lived, user-scoped signed URLs that re-run the
  authorization matrix ([ADR-0007](adr/0007-attachment-storage.md)); the signed URL
  is computed, not persisted.
- **Audit log excludes clinical content:** `metadata` records who/what/when, never
  message bodies, attachment contents/filenames, or summary text.
- **Soft deactivation:** `USER.status = DEACTIVATED` (never a hard delete) so
  history and references remain intact.

## Indexing & integrity (to implement in Phase 1)

- Partial/composite index on `(state, priority, enqueued_at)` for queue reads.
- Unique constraint enforcing one `INTAKE` and one `SUMMARY` per consultation.
- Foreign keys with restrict/soft-delete semantics to preserve history.
