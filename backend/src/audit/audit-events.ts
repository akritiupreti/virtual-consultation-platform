/**
 * Catalogue of auditable events. "Important" = security-relevant, state-changing,
 * or clinically significant (docs/amrit-feedback-responses.md C13/C20); the full
 * definition and log schema live in docs/audit-logging.md.
 *
 * Audit metadata records who / what / when only — never message bodies, attachment
 * contents, or summary text (invariants 5 & 6). Attachment events record the
 * attachment id and type/size, never the file bytes or a signed URL.
 */
export const AUDIT_EVENTS = {
  // ── Authentication (security-relevant) ──────────────────────────────────────
  LOGIN_SUCCESS: 'LOGIN_SUCCESS',
  // Failed login: metadata carries a reason code only, never the attempted password.
  LOGIN_FAILURE: 'LOGIN_FAILURE',

  // ── User management (security-relevant) ─────────────────────────────────────
  USER_DEACTIVATED: 'USER_DEACTIVATED',
  USER_REACTIVATED: 'USER_REACTIVATED',

  // ── Consultation lifecycle (state-changing) ─────────────────────────────────
  CONSULTATION_REQUESTED: 'CONSULTATION_REQUESTED',
  CONSULTATION_ENQUEUED: 'CONSULTATION_ENQUEUED',
  CONSULTATION_CLAIMED: 'CONSULTATION_CLAIMED',
  // Claim-start TTL expired → auto-requeued (CLAIMED → QUEUED), system actor (ADR-0010).
  CONSULTATION_REQUEUED: 'CONSULTATION_REQUEUED',
  // A clinician was deactivated mid-session → the case was reassigned to the queue
  // (CLAIMED/IN_SESSION → QUEUED), system actor (FR-24, ADR-0012).
  CONSULTATION_REASSIGNED: 'CONSULTATION_REASSIGNED',
  CONSULTATION_STARTED: 'CONSULTATION_STARTED',
  CONSULTATION_COMPLETED: 'CONSULTATION_COMPLETED',
  CONSULTATION_CANCELLED: 'CONSULTATION_CANCELLED',
  PRIORITY_CHANGED: 'PRIORITY_CHANGED',

  // ── Clinically significant (who/what/when only — never content) ─────────────
  MESSAGE_SENT: 'MESSAGE_SENT',
  ATTACHMENT_UPLOADED: 'ATTACHMENT_UPLOADED',
  // A participant minted a signed URL / downloaded an attachment (FR-5, C4).
  ATTACHMENT_ACCESSED: 'ATTACHMENT_ACCESSED',
  // The patient removed a file they shared by mistake, during the session (ADR-0028).
  ATTACHMENT_DELETED: 'ATTACHMENT_DELETED',
  SUMMARY_DRAFTED: 'SUMMARY_DRAFTED',
  SUMMARY_FINALIZED: 'SUMMARY_FINALIZED',
  // A reviewing doctor returned a drafted summary to the drafter to revise instead
  // of finalizing it (ADR-0024). Metadata records the drafter who must act; the
  // doctor's review note is never persisted here (invariant 6).
  SUMMARY_CHANGES_REQUESTED: 'SUMMARY_CHANGES_REQUESTED',
  // Append-only correction to a finalized summary (FR-13, C5).
  SUMMARY_ADDENDUM_ADDED: 'SUMMARY_ADDENDUM_ADDED',
} as const;

export type AuditEventType = (typeof AUDIT_EVENTS)[keyof typeof AUDIT_EVENTS];
