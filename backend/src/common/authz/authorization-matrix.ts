import { Role } from '@prisma/client';

/**
 * Authorization matrix — the single source of truth for the ROLE + OWNERSHIP
 * dimension of authorization. Mirrors docs/authorization-matrix.md.
 *
 * The STATE dimension lives in the transition registry (../state-machine/transitions.ts).
 * `authorizeConsultationAction` in ./policy.ts composes role → state → ownership so
 * that services never re-implement any of these checks ad hoc (invariants 1 & 4).
 *
 * Deny-by-default: an action/role pair not listed here is denied. Admin never
 * appears in a clinical-content row, so separation of duties (invariant 3) is
 * encoded by omission and enforced by the deny-by-default rule.
 */
export enum Action {
  SUBMIT_REQUEST = 'SUBMIT_REQUEST',
  CANCEL_REQUEST = 'CANCEL_REQUEST',
  VIEW_OWN_POSITION = 'VIEW_OWN_POSITION',
  VIEW_QUEUE = 'VIEW_QUEUE',
  VIEW_CONSULTATION = 'VIEW_CONSULTATION',
  SET_PRIORITY = 'SET_PRIORITY',
  CLAIM_CASE = 'CLAIM_CASE',
  START_CONSULTATION = 'START_CONSULTATION',
  END_CONSULTATION = 'END_CONSULTATION',
  SEND_MESSAGE = 'SEND_MESSAGE',
  READ_MESSAGES = 'READ_MESSAGES',
  UPLOAD_ATTACHMENT = 'UPLOAD_ATTACHMENT',
  VIEW_ATTACHMENT = 'VIEW_ATTACHMENT',
  DRAFT_SUMMARY = 'DRAFT_SUMMARY',
  FINALIZE_SUMMARY = 'FINALIZE_SUMMARY',
  REQUEST_SUMMARY_CHANGES = 'REQUEST_SUMMARY_CHANGES',
  ADD_ADDENDUM = 'ADD_ADDENDUM',
  VIEW_SUMMARY = 'VIEW_SUMMARY',
  VIEW_AUDIT_LOG = 'VIEW_AUDIT_LOG',
  MANAGE_USERS = 'MANAGE_USERS',
}

/** Ownership / participation guard required in addition to the role check. */
export enum Ownership {
  /** No ownership constraint beyond role. */
  NONE = 'NONE',
  /** The patient who owns the consultation (`patientId === actor`). */
  OWNER = 'OWNER',
  /** The clinician the case is assigned to (`claimedBy === actor`). */
  ASSIGNED_CLINICIAN = 'ASSIGNED_CLINICIAN',
  /** Owner OR assigned clinician — the two parties in the room. */
  PARTICIPANT = 'PARTICIPANT',
  /**
   * The two participants, OR a doctor while the case is awaiting sign-off.
   *
   * A nurse-run case ends in `ENDED` with a drafted-but-unfinalized summary and
   * has no doctor participant, yet `FINALIZE_SUMMARY` is `role=DOCTOR,
   * ownership=NONE` — so any doctor may finalize it but, under plain
   * `PARTICIPANT`, could not read what they are about to sign. This closes that
   * read/finalize asymmetry: a doctor may read exactly the cases they are
   * empowered to finalize, and nothing more. Admin is never DOCTOR, so it stays
   * excluded (invariant 3); the "awaiting sign-off" states are the
   * `FINALIZE_SUMMARY` transition's `from` set (registry = single source,
   * enforcement rule 3), so this never drifts from what is actually finalizable.
   */
  PARTICIPANT_OR_SIGNOFF_DOCTOR = 'PARTICIPANT_OR_SIGNOFF_DOCTOR',
}

export interface Permission {
  roles: Role[];
  ownership: Ownership;
}

export const AUTHORIZATION_MATRIX: Record<Action, Permission> = {
  [Action.SUBMIT_REQUEST]: { roles: [Role.PATIENT], ownership: Ownership.NONE },
  [Action.CANCEL_REQUEST]: { roles: [Role.PATIENT], ownership: Ownership.OWNER },
  [Action.VIEW_OWN_POSITION]: { roles: [Role.PATIENT], ownership: Ownership.OWNER },
  [Action.VIEW_QUEUE]: { roles: [Role.NURSE, Role.DOCTOR], ownership: Ownership.NONE },
  // Full consultation detail (incl. intake) unlocks for the two participants; an
  // unassigned clinician sees only the minimal pre-claim queue view — except a
  // doctor reviewing a case that is awaiting sign-off, who needs the clinical
  // picture to finalise it responsibly (see Ownership.PARTICIPANT_OR_SIGNOFF_DOCTOR).
  [Action.VIEW_CONSULTATION]: {
    roles: [Role.PATIENT, Role.NURSE, Role.DOCTOR],
    ownership: Ownership.PARTICIPANT_OR_SIGNOFF_DOCTOR,
  },
  [Action.SET_PRIORITY]: { roles: [Role.NURSE, Role.DOCTOR], ownership: Ownership.NONE },
  [Action.CLAIM_CASE]: { roles: [Role.NURSE, Role.DOCTOR], ownership: Ownership.NONE },
  [Action.START_CONSULTATION]: {
    roles: [Role.NURSE, Role.DOCTOR],
    ownership: Ownership.ASSIGNED_CLINICIAN,
  },
  [Action.END_CONSULTATION]: {
    roles: [Role.NURSE, Role.DOCTOR],
    ownership: Ownership.ASSIGNED_CLINICIAN,
  },
  [Action.SEND_MESSAGE]: {
    roles: [Role.PATIENT, Role.NURSE, Role.DOCTOR],
    ownership: Ownership.PARTICIPANT,
  },
  [Action.READ_MESSAGES]: {
    roles: [Role.PATIENT, Role.NURSE, Role.DOCTOR],
    ownership: Ownership.PARTICIPANT,
  },
  // Attachments are clinical content: participants only, never admin (deny by
  // omission). Upload is additionally gated to IN_SESSION in the service, like
  // messaging; download is allowed in and after a session so both parties can
  // review it, and is served only via a short-lived, user-scoped signed URL (C4).
  [Action.UPLOAD_ATTACHMENT]: {
    roles: [Role.PATIENT, Role.NURSE, Role.DOCTOR],
    ownership: Ownership.PARTICIPANT,
  },
  [Action.VIEW_ATTACHMENT]: {
    roles: [Role.PATIENT, Role.NURSE, Role.DOCTOR],
    ownership: Ownership.PARTICIPANT,
  },
  [Action.DRAFT_SUMMARY]: {
    roles: [Role.NURSE, Role.DOCTOR],
    ownership: Ownership.ASSIGNED_CLINICIAN,
  },
  // Finalize is doctor-only and keyed to state=ENDED (transition registry). It is
  // NOT tied to the assigned clinician, so a doctor can finalize a case a nurse ran.
  [Action.FINALIZE_SUMMARY]: { roles: [Role.DOCTOR], ownership: Ownership.NONE },
  // Request changes is the reviewing doctor's alternative to finalizing: instead of
  // signing a draft they disagree with, they return it to the drafter to revise.
  // Doctor-only and not participant-scoped, exactly like FINALIZE_SUMMARY (a doctor
  // may request changes on a nurse-run case). The state gate (ENDED, draft exists,
  // not finalized) lives in the service; no state transition occurs — the case
  // stays ENDED so the assigned clinician can re-draft (ADR-0024). Never admin.
  [Action.REQUEST_SUMMARY_CHANGES]: { roles: [Role.DOCTOR], ownership: Ownership.NONE },
  // Append-only correction to a finalized (immutable) summary. Clinicians only;
  // the service gates it to state=SUMMARIZED (FR-13, C5). Never admin.
  [Action.ADD_ADDENDUM]: { roles: [Role.NURSE, Role.DOCTOR], ownership: Ownership.NONE },
  // Participants see the summary (the patient only once finalised, gated in the
  // service); a doctor may also read a drafted summary on a case awaiting their
  // sign-off, so they can review it before finalising (invariant 3: never admin).
  [Action.VIEW_SUMMARY]: {
    roles: [Role.PATIENT, Role.NURSE, Role.DOCTOR],
    ownership: Ownership.PARTICIPANT_OR_SIGNOFF_DOCTOR,
  },
  [Action.VIEW_AUDIT_LOG]: { roles: [Role.ADMIN], ownership: Ownership.NONE },
  // User management is admin-only and not consultation-scoped (no ownership); it
  // is enforced by the controller's role gate. Listed here so the matrix remains
  // the single source of truth. Admins manage users but never read clinical content.
  [Action.MANAGE_USERS]: { roles: [Role.ADMIN], ownership: Ownership.NONE },
};

/** Coarse role check. Deny-by-default for any unknown action. */
export function can(action: Action, role: Role): boolean {
  const permission = AUTHORIZATION_MATRIX[action];
  if (!permission) {
    return false;
  }
  return permission.roles.includes(role);
}

export function ownershipFor(action: Action): Ownership {
  return AUTHORIZATION_MATRIX[action]?.ownership ?? Ownership.NONE;
}
