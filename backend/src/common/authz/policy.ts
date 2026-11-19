import { ConsultationState, Role } from '@prisma/client';
import { ForbiddenActionException, IllegalTransitionException } from '../errors/domain-exceptions';
import { transitionFor } from '../state-machine/transitions';
import { Action, Ownership, can, ownershipFor } from './authorization-matrix';

/**
 * States in which a case is "awaiting doctor sign-off" — sourced from the
 * FINALIZE_SUMMARY transition so the read guard can never diverge from the set
 * of states a doctor can actually finalise from (enforcement rule 3). Today that
 * is exactly ENDED; it tracks the registry if that ever changes.
 */
const SIGNOFF_PENDING_STATES: ReadonlyArray<ConsultationState> =
  transitionFor(Action.FINALIZE_SUMMARY)?.from ?? [];

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
  /**
   * The doctor who finalized the summary, if any. Populated only for summary
   * reads (`VIEW_SUMMARY`) so the finalizing doctor keeps read access to the
   * record they signed once the case leaves the sign-off window (ADR-0020).
   * Absent for every other action, where it has no effect.
   */
  finalizedBy?: string | null;
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
    case Ownership.PARTICIPANT_OR_SIGNOFF_DOCTOR: {
      const isParticipant =
        consultation.patientId === user.id || consultation.claimedBy === user.id;
      // Any doctor may read a case that is awaiting sign-off, so they can review
      // (and then finalise, which is already role=DOCTOR/ownership=NONE) a case a
      // nurse ran and no doctor ever joined. Never widens to admin (not DOCTOR).
      const isSignoffDoctor =
        user.role === Role.DOCTOR && SIGNOFF_PENDING_STATES.includes(consultation.state);
      // The doctor who finalised a summary keeps read access to that record once
      // the case leaves the sign-off window (ENDED → SUMMARIZED). Without this the
      // signing doctor on a nurse-run case — who is not a participant — would be
      // locked out of the very summary they just signed (ADR-0020). Strictly the
      // one finalising doctor, never "any doctor", so exposure stays minimal
      // (invariant 6); `finalizedBy` is set only for VIEW_SUMMARY.
      const isFinalizingDoctor =
        user.role === Role.DOCTOR &&
        consultation.finalizedBy != null &&
        consultation.finalizedBy === user.id;
      if (!isParticipant && !isSignoffDoctor && !isFinalizingDoctor) {
        throw new ForbiddenActionException();
      }
      break;
    }
    case Ownership.NONE:
      break;
  }
}
