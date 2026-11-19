/**
 * Catalogue of auditable events. "Important" = security-relevant, state-changing,
 * or clinically significant (docs/amrit-feedback-responses.md C13/C20); the full
 * definition and log schema live in docs/audit-logging.md.
 *
 * Audit metadata records who / what / when only — never message bodies or summary
 * text (invariants 5 & 6).
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
  // Claim-start TTL expired → auto-requeued (CLAIMED → QUEUED), system actor (ADR-0008).
  CONSULTATION_REQUEUED: 'CONSULTATION_REQUEUED',
  CONSULTATION_STARTED: 'CONSULTATION_STARTED',
  CONSULTATION_COMPLETED: 'CONSULTATION_COMPLETED',
  CONSULTATION_CANCELLED: 'CONSULTATION_CANCELLED',
  PRIORITY_CHANGED: 'PRIORITY_CHANGED',

  // ── Clinically significant (who/what/when only — never content) ─────────────
  MESSAGE_SENT: 'MESSAGE_SENT',
  SUMMARY_DRAFTED: 'SUMMARY_DRAFTED',
  SUMMARY_FINALIZED: 'SUMMARY_FINALIZED',
} as const;

export type AuditEventType = (typeof AUDIT_EVENTS)[keyof typeof AUDIT_EVENTS];
