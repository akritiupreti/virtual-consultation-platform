/**
 * Synthetic test fixtures. NONE of this is real patient/clinical data — the
 * strings are obviously fake placeholders (invariant 6: tests and fixtures must
 * not leak real clinical data). Kept in one place so component, a11y and visual
 * suites render identical, deterministic content.
 */
import type {
  AssignedConsultation,
  AuditEntry,
  AuthUser,
  ConsultationDetail,
  Message,
  MyConsultation,
  PendingSignoff,
  QueueItem,
  Summary,
  UserAccount,
} from '../lib/api';

export const users: Record<string, AuthUser> = {
  patient: { id: 'u-patient', email: 'patient@example.test', role: 'PATIENT' },
  nurse: { id: 'u-nurse', email: 'nurse@example.test', role: 'NURSE' },
  doctor: { id: 'u-doctor', email: 'doctor@example.test', role: 'DOCTOR' },
  admin: { id: 'u-admin', email: 'admin@example.test', role: 'ADMIN' },
};

export const queue: QueueItem[] = [
  {
    id: 'c-1',
    priority: 'EMERGENCY',
    symptomCategory: 'Respiratory',
    severity: 5,
    complaintSummary: 'Sample complaint one (synthetic)',
    enqueuedAt: '2026-10-22T09:00:00.000Z',
    waitingSeconds: 600,
  },
  {
    id: 'c-2',
    priority: 'ROUTINE',
    symptomCategory: 'Dermatology',
    severity: 2,
    complaintSummary: 'Sample complaint two (synthetic)',
    enqueuedAt: '2026-10-22T09:05:00.000Z',
    waitingSeconds: 300,
  },
];

export const myConsultations: MyConsultation[] = [
  {
    id: 'c-1',
    state: 'QUEUED',
    priority: 'ROUTINE',
    createdAt: '2026-10-22T09:00:00.000Z',
    complaintSummary: 'Sample complaint (synthetic)',
    position: 2,
    summaryAvailable: false,
  },
];

export const assignedConsultations: AssignedConsultation[] = [
  {
    id: 'c-1',
    state: 'SUMMARIZED',
    priority: 'URGENT',
    symptomCategory: 'Respiratory',
    complaintSummary: 'Sample complaint (synthetic)',
    claimedAt: '2026-10-22T09:02:00.000Z',
    startedAt: '2026-10-22T09:03:00.000Z',
    endedAt: '2026-10-22T09:20:00.000Z',
    summaryDrafted: true,
    summaryFinalized: true,
  },
  {
    id: 'c-2',
    state: 'CLAIMED',
    priority: 'ROUTINE',
    symptomCategory: 'Dermatology',
    complaintSummary: 'Another complaint (synthetic)',
    claimedAt: '2026-10-22T09:30:00.000Z',
    startedAt: null,
    endedAt: null,
    summaryDrafted: false,
    summaryFinalized: false,
  },
];

export const pendingSignoff: PendingSignoff[] = [
  {
    id: 'c-1',
    priority: 'URGENT',
    symptomCategory: 'Respiratory',
    complaintSummary: 'Sample complaint (synthetic)',
    endedAt: '2026-10-22T09:20:00.000Z',
    draftedBy: 'u-nurse',
    draftedAt: '2026-10-22T09:22:00.000Z',
  },
  {
    id: 'c-2',
    priority: 'ROUTINE',
    symptomCategory: 'Dermatology',
    complaintSummary: 'Another complaint (synthetic)',
    endedAt: '2026-10-22T09:40:00.000Z',
    draftedBy: 'u-nurse',
    draftedAt: '2026-10-22T09:41:00.000Z',
  },
];

export function consultation(overrides: Partial<ConsultationDetail> = {}): ConsultationDetail {
  return {
    id: 'c-1',
    state: 'IN_SESSION',
    priority: 'URGENT',
    patientId: 'u-patient',
    claimedBy: 'u-doctor',
    createdAt: '2026-10-22T09:00:00.000Z',
    enqueuedAt: '2026-10-22T09:00:05.000Z',
    claimedAt: '2026-10-22T09:02:00.000Z',
    startedAt: '2026-10-22T09:03:00.000Z',
    endedAt: null,
    intake: {
      chiefComplaint: 'Synthetic chief complaint',
      symptomCategory: 'General',
      onsetDuration: '2 days',
      severity: 3,
      history: null,
      medications: null,
      consentAt: '2026-10-22T08:59:00.000Z',
    },
    summaryAvailable: false,
    summaryFinalized: false,
    ...overrides,
  };
}

export const messages: Message[] = [
  {
    id: 'm-1',
    senderId: 'u-patient',
    body: 'Sample patient message',
    createdAt: '2026-10-22T09:04:00.000Z',
  },
  {
    id: 'm-2',
    senderId: 'u-doctor',
    body: 'Sample clinician reply',
    createdAt: '2026-10-22T09:04:30.000Z',
  },
];

export function summary(overrides: Partial<Summary> = {}): Summary {
  return {
    consultationId: 'c-1',
    content: 'Synthetic summary content for testing only.',
    draftedBy: 'u-doctor',
    finalizedBy: 'u-doctor',
    finalizedAt: '2026-10-22T09:10:00.000Z',
    finalized: true,
    ...overrides,
  };
}

export const userAccounts: UserAccount[] = [
  {
    id: 'u-admin',
    email: 'admin@example.test',
    role: 'ADMIN',
    status: 'ACTIVE',
    createdAt: '2026-10-20T08:00:00.000Z',
  },
  {
    id: 'u-nurse',
    email: 'nurse@example.test',
    role: 'NURSE',
    status: 'ACTIVE',
    createdAt: '2026-10-20T08:05:00.000Z',
  },
  {
    id: 'u-doctor',
    email: 'doctor@example.test',
    role: 'DOCTOR',
    status: 'DEACTIVATED',
    createdAt: '2026-10-20T08:10:00.000Z',
  },
];

export const audit: AuditEntry[] = [
  {
    id: 'a-1',
    actorId: 'u-doctor',
    eventType: 'CONSULTATION_CLAIMED',
    consultationId: 'c-1',
    metadata: { correlationId: 'corr-1' },
    createdAt: '2026-10-22T09:02:00.000Z',
  },
  {
    id: 'a-2',
    actorId: 'u-doctor',
    eventType: 'SUMMARY_FINALIZED',
    consultationId: 'c-1',
    metadata: { correlationId: 'corr-2' },
    createdAt: '2026-10-22T09:10:00.000Z',
  },
];
