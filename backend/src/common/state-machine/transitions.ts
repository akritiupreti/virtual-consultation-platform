import { ConsultationState } from '@prisma/client';
import { Action } from '../authz/authorization-matrix';

/**
 * Transition registry — the central bank of consultation state transitions
 * (docs/state-machine.md). It is the single definition of which action is legal
 * in which state (invariant 1). Both the API layer and the authorization policy
 * read from it; no handler re-encodes transition logic.
 *
 * User-invokable transitions are keyed by {@link Action}; system transitions
 * (enqueue, requeue) are keyed by string triggers below.
 */
export interface Transition {
  from: ConsultationState[];
  to: ConsultationState;
  /** Human-readable actor label for the docs/registry (not an authz check). */
  actor: 'PATIENT' | 'CLINICIAN' | 'DOCTOR' | 'SYSTEM';
  note?: string;
}

/** System triggers that are not initiated by a user action. */
export const ENQUEUE = 'ENQUEUE';
export const REQUEUE = 'REQUEUE';

export type TransitionTrigger = Action | typeof ENQUEUE | typeof REQUEUE;

const S = ConsultationState;

export const TRANSITIONS: Record<string, Transition> = {
  // System: a valid, consented, prioritized intake moves REQUESTED → QUEUED.
  [ENQUEUE]: { from: [S.REQUESTED], to: S.QUEUED, actor: 'SYSTEM' },

  [Action.CLAIM_CASE]: { from: [S.QUEUED], to: S.CLAIMED, actor: 'CLINICIAN' },
  [Action.START_CONSULTATION]: { from: [S.CLAIMED], to: S.IN_SESSION, actor: 'CLINICIAN' },
  [Action.END_CONSULTATION]: { from: [S.IN_SESSION], to: S.ENDED, actor: 'CLINICIAN' },
  [Action.FINALIZE_SUMMARY]: { from: [S.ENDED], to: S.SUMMARIZED, actor: 'DOCTOR' },
  [Action.CANCEL_REQUEST]: {
    from: [S.REQUESTED, S.QUEUED, S.CLAIMED],
    to: S.CANCELLED,
    actor: 'PATIENT',
  },

  // System: a claim not started within the start-TTL requeues. Defined here so the
  // machine is complete; the TTL trigger itself is wired in Phase 3 (FR-12).
  [REQUEUE]: {
    from: [S.CLAIMED],
    to: S.QUEUED,
    actor: 'SYSTEM',
    note: 'Start-TTL expiry — wired in Phase 3',
  },
};

/** Terminal states have no outgoing transitions. */
export const TERMINAL_STATES: ReadonlySet<ConsultationState> = new Set([S.SUMMARIZED, S.CANCELLED]);

export function transitionFor(trigger: TransitionTrigger): Transition | undefined {
  return TRANSITIONS[trigger];
}

export function isTransitionAllowed(
  trigger: TransitionTrigger,
  current: ConsultationState,
): boolean {
  const transition = TRANSITIONS[trigger];
  return transition ? transition.from.includes(current) : false;
}
