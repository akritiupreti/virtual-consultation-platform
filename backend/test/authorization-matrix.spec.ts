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
});
