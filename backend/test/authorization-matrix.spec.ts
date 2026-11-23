import { ConsultationState, Role } from '@prisma/client';
import { Action, can } from '../src/common/authz/authorization-matrix';
import { authorizeConsultationAction } from '../src/common/authz/policy';
import {
  ForbiddenActionException,
  IllegalTransitionException,
} from '../src/common/errors/domain-exceptions';

/** Clinical content actions an admin must never be permitted (separation of duties). */
const CLINICAL_ACTIONS = [
  Action.VIEW_CONSULTATION,
  Action.SEND_MESSAGE,
  Action.READ_MESSAGES,
  Action.DRAFT_SUMMARY,
  Action.FINALIZE_SUMMARY,
  Action.VIEW_SUMMARY,
];

describe('authorization matrix (role dimension)', () => {
  it('only a patient may submit a request', () => {
    expect(can(Action.SUBMIT_REQUEST, Role.PATIENT)).toBe(true);
    for (const role of [Role.NURSE, Role.DOCTOR, Role.ADMIN]) {
      expect(can(Action.SUBMIT_REQUEST, role)).toBe(false);
    }
  });

  it('only clinicians may view the triage queue', () => {
    expect(can(Action.VIEW_QUEUE, Role.NURSE)).toBe(true);
    expect(can(Action.VIEW_QUEUE, Role.DOCTOR)).toBe(true);
    expect(can(Action.VIEW_QUEUE, Role.PATIENT)).toBe(false);
    expect(can(Action.VIEW_QUEUE, Role.ADMIN)).toBe(false);
  });

  it('finalize is doctor-only — a nurse cannot escalate (SC-7)', () => {
    expect(can(Action.FINALIZE_SUMMARY, Role.DOCTOR)).toBe(true);
    expect(can(Action.FINALIZE_SUMMARY, Role.NURSE)).toBe(false);
    expect(can(Action.FINALIZE_SUMMARY, Role.PATIENT)).toBe(false);
  });

  it('admins can never read clinical content (separation of duties, SC-6)', () => {
    for (const action of CLINICAL_ACTIONS) {
      expect(can(action, Role.ADMIN)).toBe(false);
    }
  });

  it('only an admin may read the audit log', () => {
    expect(can(Action.VIEW_AUDIT_LOG, Role.ADMIN)).toBe(true);
    for (const role of [Role.PATIENT, Role.NURSE, Role.DOCTOR]) {
      expect(can(Action.VIEW_AUDIT_LOG, role)).toBe(false);
    }
  });

  it('only an admin may manage users; no clinician/patient escalation (SC-7)', () => {
    expect(can(Action.MANAGE_USERS, Role.ADMIN)).toBe(true);
    for (const role of [Role.PATIENT, Role.NURSE, Role.DOCTOR]) {
      expect(can(Action.MANAGE_USERS, role)).toBe(false);
    }
  });

  it('messaging is participant-clinical: patients + clinicians, never admin', () => {
    for (const action of [Action.SEND_MESSAGE, Action.READ_MESSAGES]) {
      expect(can(action, Role.PATIENT)).toBe(true);
      expect(can(action, Role.NURSE)).toBe(true);
      expect(can(action, Role.DOCTOR)).toBe(true);
      expect(can(action, Role.ADMIN)).toBe(false);
    }
  });

  it('is deny-by-default for an unknown action', () => {
    expect(can('NOT_AN_ACTION' as Action, Role.ADMIN)).toBe(false);
  });
});

describe('authorizeConsultationAction (role → state → ownership composition)', () => {
  const nurse = { id: 'nurse-1', role: Role.NURSE };
  const otherNurse = { id: 'nurse-2', role: Role.NURSE };
  const patient = { id: 'patient-1', role: Role.PATIENT };

  const claimedByNurse = {
    patientId: patient.id,
    claimedBy: nurse.id,
    state: ConsultationState.CLAIMED,
  };

  it('rejects a disallowed role with 403 before anything else', () => {
    expect(() => authorizeConsultationAction(patient, claimedByNurse, Action.CLAIM_CASE)).toThrow(
      ForbiddenActionException,
    );
  });

  it('rejects an illegal state with 409 (claimer starting too early is state, not role)', () => {
    const queued = { ...claimedByNurse, state: ConsultationState.QUEUED };
    expect(() => authorizeConsultationAction(nurse, queued, Action.START_CONSULTATION)).toThrow(
      IllegalTransitionException,
    );
  });

  it('rejects a non-owner clinician with 403', () => {
    expect(() =>
      authorizeConsultationAction(otherNurse, claimedByNurse, Action.START_CONSULTATION),
    ).toThrow(ForbiddenActionException);
  });

  it('allows the assigned clinician to start a claimed consultation', () => {
    expect(() =>
      authorizeConsultationAction(nurse, claimedByNurse, Action.START_CONSULTATION),
    ).not.toThrow();
  });

  it('denies an admin reading messages (role check, 403)', () => {
    const admin = { id: 'admin-1', role: Role.ADMIN };
    expect(() => authorizeConsultationAction(admin, claimedByNurse, Action.READ_MESSAGES)).toThrow(
      ForbiddenActionException,
    );
  });

  it('denies a non-participant clinician reading messages (membership-scoped)', () => {
    const inSession = { ...claimedByNurse, state: ConsultationState.IN_SESSION };
    expect(() => authorizeConsultationAction(otherNurse, inSession, Action.READ_MESSAGES)).toThrow(
      ForbiddenActionException,
    );
  });

  it('allows the patient owner and assigned clinician to read messages', () => {
    const inSession = { ...claimedByNurse, state: ConsultationState.IN_SESSION };
    expect(() =>
      authorizeConsultationAction(patient, inSession, Action.READ_MESSAGES),
    ).not.toThrow();
    expect(() => authorizeConsultationAction(nurse, inSession, Action.READ_MESSAGES)).not.toThrow();
  });
});

/**
 * Doctor sign-off read window (ADR-0009): FINALIZE_SUMMARY is doctor-only and not
 * participant-scoped, so a doctor may also READ a case (detail + summary) while it
 * is awaiting sign-off (ENDED), even one a nurse ran and no doctor joined — but
 * nothing wider.
 */
describe('doctor sign-off read window (PARTICIPANT_OR_SIGNOFF_DOCTOR)', () => {
  const otherDoctor = { id: 'doc-2', role: Role.DOCTOR };
  const otherNurse = { id: 'nurse-2', role: Role.NURSE };
  const patient = { id: 'patient-1', role: Role.PATIENT };
  // A nurse ran this case; no doctor ever participated.
  const nurseRunEnded = {
    patientId: patient.id,
    claimedBy: 'nurse-1',
    state: ConsultationState.ENDED,
  };
  const SIGNOFF_READS = [Action.VIEW_CONSULTATION, Action.VIEW_SUMMARY];

  it('lets a non-participant doctor read an ENDED case awaiting sign-off', () => {
    for (const action of SIGNOFF_READS) {
      expect(() => authorizeConsultationAction(otherDoctor, nurseRunEnded, action)).not.toThrow();
    }
  });

  it('still denies a non-participant doctor before the case has ended', () => {
    const inSession = { ...nurseRunEnded, state: ConsultationState.IN_SESSION };
    for (const action of SIGNOFF_READS) {
      expect(() => authorizeConsultationAction(otherDoctor, inSession, action)).toThrow(
        ForbiddenActionException,
      );
    }
  });

  it('does not extend the read window to a non-participant nurse or other patient', () => {
    const otherPatient = { id: 'patient-2', role: Role.PATIENT };
    for (const action of SIGNOFF_READS) {
      expect(() => authorizeConsultationAction(otherNurse, nurseRunEnded, action)).toThrow(
        ForbiddenActionException,
      );
      expect(() => authorizeConsultationAction(otherPatient, nurseRunEnded, action)).toThrow(
        ForbiddenActionException,
      );
    }
  });

  it('still admits the genuine participants (owner + assigned clinician)', () => {
    const assignedNurse = { id: 'nurse-1', role: Role.NURSE };
    for (const action of SIGNOFF_READS) {
      expect(() => authorizeConsultationAction(assignedNurse, nurseRunEnded, action)).not.toThrow();
      expect(() => authorizeConsultationAction(patient, nurseRunEnded, action)).not.toThrow();
    }
  });
});

/**
 * Finalizing doctor keeps read access to the summary they signed (ADR-0009).
 * The sign-off read window (above) is scoped to ENDED, so without this a doctor
 * who signs off a nurse-run case — a non-participant — would be locked out of the
 * record the instant they finalize it (ENDED → SUMMARIZED). The grant is keyed to
 * `finalizedBy`, so it is exactly the one signing doctor and nothing wider, and it
 * is carried only for VIEW_SUMMARY — the consultation detail stays membership-scoped.
 */
describe('finalizing doctor summary read (ADR-0009)', () => {
  const signingDoctor = { id: 'doc-2', role: Role.DOCTOR };
  const otherDoctor = { id: 'doc-3', role: Role.DOCTOR };
  const patient = { id: 'patient-1', role: Role.PATIENT };
  // A nurse ran this case; a non-participant doctor signed it, so it is now SUMMARIZED.
  const signedByDoctor = {
    patientId: patient.id,
    claimedBy: 'nurse-1',
    state: ConsultationState.SUMMARIZED,
    finalizedBy: signingDoctor.id,
  };

  it('lets the finalizing doctor read the summary after sign-off (SUMMARIZED)', () => {
    expect(() =>
      authorizeConsultationAction(signingDoctor, signedByDoctor, Action.VIEW_SUMMARY),
    ).not.toThrow();
  });

  it('does not extend to a different doctor who did not finalize it', () => {
    expect(() =>
      authorizeConsultationAction(otherDoctor, signedByDoctor, Action.VIEW_SUMMARY),
    ).toThrow(ForbiddenActionException);
  });

  it('does not re-open the consultation detail — that stays membership-scoped', () => {
    // VIEW_CONSULTATION never carries `finalizedBy`, so the signing doctor remains
    // locked out of the intake once the case leaves the sign-off window (ADR-0009).
    const detailRef = {
      patientId: patient.id,
      claimedBy: 'nurse-1',
      state: ConsultationState.SUMMARIZED,
    };
    expect(() =>
      authorizeConsultationAction(signingDoctor, detailRef, Action.VIEW_CONSULTATION),
    ).toThrow(ForbiddenActionException);
  });
});
