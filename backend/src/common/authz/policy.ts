import { ConsultationState, Role } from '@prisma/client';
import { ForbiddenActionException, IllegalTransitionException } from '../errors/domain-exceptions';
import { transitionFor } from '../state-machine/transitions';
import { Action, Ownership, can, ownershipFor } from './authorization-matrix';

/** The acting user, reduced to what authorization needs. */
export interface ActingUser {
  id: string;
  role: Role;
}

/** The consultation fields authorization depends on. */
export interface ConsultationRef {
  patientId: string;
  claimedBy: string | null;
  state: ConsultationState;
}

/**
 * The single authorization composition point used by every consultation-scoped
 * service. Order matters so the correct HTTP code surfaces (docs/state-machine.md):
 *
 *   1. role      — matrix.can(...)                → 403 if the role may never act
 *   2. state     — transition registry (if any)   → 409 if illegal from this state
 *   3. ownership — owner / assigned / participant → 403 if not this user's case
 *
 * Checking role before state means e.g. a nurse finalizing gets 403 (role), while
 * the assigned clinician starting too early gets 409 (state).
 */
export function authorizeConsultationAction(
  user: ActingUser,
  consultation: ConsultationRef,
  action: Action,
): void {
  if (!can(action, user.role)) {
    throw new ForbiddenActionException();
  }

  const transition = transitionFor(action);
  if (transition && !transition.from.includes(consultation.state)) {
    throw new IllegalTransitionException(action, consultation.state);
  }

  assertOwnership(user, consultation, ownershipFor(action));
}

function assertOwnership(
  user: ActingUser,
  consultation: ConsultationRef,
  ownership: Ownership,
): void {
  switch (ownership) {
    case Ownership.OWNER:
      if (consultation.patientId !== user.id) {
        throw new ForbiddenActionException();
      }
      break;
    case Ownership.ASSIGNED_CLINICIAN:
      if (consultation.claimedBy !== user.id) {
        throw new ForbiddenActionException();
      }
      break;
    case Ownership.PARTICIPANT:
      if (consultation.patientId !== user.id && consultation.claimedBy !== user.id) {
        throw new ForbiddenActionException();
      }
      break;
    case Ownership.NONE:
      break;
  }
}
