/**
 * Catalogue of auditable events emitted in the MVP slice. "Important" =
 * security-relevant, state-changing, or clinically significant (see
 * docs/amrit-feedback-responses.md C13/C20; full catalogue lands in Phase 4).
 *
 * Audit metadata records who / what / when only — never message bodies,
 * attachment contents, or summary text (invariant 5 & 6).
 */
export const AUDIT_EVENTS = {
  CONSULTATION_REQUESTED: 'CONSULTATION_REQUESTED',
  CONSULTATION_ENQUEUED: 'CONSULTATION_ENQUEUED',
  CONSULTATION_CLAIMED: 'CONSULTATION_CLAIMED',
  // Claim-start TTL expired → auto-requeued (CLAIMED → QUEUED), system actor (ADR-0010).
  CONSULTATION_REQUEUED: 'CONSULTATION_REQUEUED',
  CONSULTATION_STARTED: 'CONSULTATION_STARTED',
  CONSULTATION_COMPLETED: 'CONSULTATION_COMPLETED',
  CONSULTATION_CANCELLED: 'CONSULTATION_CANCELLED',
  PRIORITY_CHANGED: 'PRIORITY_CHANGED',
  MESSAGE_SENT: 'MESSAGE_SENT',
  SUMMARY_DRAFTED: 'SUMMARY_DRAFTED',
  SUMMARY_FINALIZED: 'SUMMARY_FINALIZED',
} as const;

export type AuditEventType = (typeof AUDIT_EVENTS)[keyof typeof AUDIT_EVENTS];
