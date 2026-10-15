import { ConsultationState } from '@prisma/client';
import { Action } from '../src/common/authz/authorization-matrix';
import {
  ENQUEUE,
  isTransitionAllowed,
  REASSIGN,
  REQUEUE,
  TERMINAL_STATES,
  transitionFor,
  TransitionTrigger,
} from '../src/common/state-machine/transitions';

const S = ConsultationState;

/**
 * The transition registry is the single source of truth for legal state changes
 * (docs/state-machine.md). These assert the allowed transitions and, crucially,
 * that the invalid transitions in the spec's "explicitly rejected" table are not.
 */
describe('transition registry', () => {
  describe('allowed transitions', () => {
    it('ENQUEUE moves REQUESTED → QUEUED', () => {
      expect(transitionFor(ENQUEUE)).toMatchObject({ from: [S.REQUESTED], to: S.QUEUED });
    });

    it.each<[Action, ConsultationState, ConsultationState]>([
      [Action.CLAIM_CASE, S.QUEUED, S.CLAIMED],
      [Action.START_CONSULTATION, S.CLAIMED, S.IN_SESSION],
      [Action.END_CONSULTATION, S.IN_SESSION, S.ENDED],
      [Action.FINALIZE_SUMMARY, S.ENDED, S.SUMMARIZED],
    ])('%s is allowed from %s → %s', (action, from, to) => {
      expect(isTransitionAllowed(action, from)).toBe(true);
      expect(transitionFor(action)?.to).toBe(to);
    });

    it('CANCEL_REQUEST is allowed from REQUESTED, QUEUED and CLAIMED', () => {
      for (const from of [S.REQUESTED, S.QUEUED, S.CLAIMED]) {
        expect(isTransitionAllowed(Action.CANCEL_REQUEST, from)).toBe(true);
      }
    });

    it('REQUEUE (start-TTL) moves CLAIMED → QUEUED', () => {
      expect(transitionFor(REQUEUE)).toMatchObject({ from: [S.CLAIMED], to: S.QUEUED });
    });

    it('REASSIGN (mid-session deactivation) moves CLAIMED or IN_SESSION → QUEUED', () => {
      const transition = transitionFor(REASSIGN);
      expect(transition?.to).toBe(S.QUEUED);
      expect(transition?.from).toEqual(expect.arrayContaining([S.CLAIMED, S.IN_SESSION]));
      expect(isTransitionAllowed(REASSIGN, S.IN_SESSION)).toBe(true);
      expect(isTransitionAllowed(REASSIGN, S.CLAIMED)).toBe(true);
      // Not from a state where there is nothing to reassign.
      expect(isTransitionAllowed(REASSIGN, S.QUEUED)).toBe(false);
      expect(isTransitionAllowed(REASSIGN, S.ENDED)).toBe(false);
    });
  });

  describe('explicitly rejected transitions (docs/state-machine.md)', () => {
    it('QUEUED → IN_SESSION is rejected (must be claimed first)', () => {
      expect(isTransitionAllowed(Action.START_CONSULTATION, S.QUEUED)).toBe(false);
    });

    it('ENDED → IN_SESSION is rejected (no reopening)', () => {
      expect(isTransitionAllowed(Action.START_CONSULTATION, S.ENDED)).toBe(false);
    });

    it('ENDED cannot be completed again', () => {
      expect(isTransitionAllowed(Action.END_CONSULTATION, S.ENDED)).toBe(false);
    });

    it('CANCEL is rejected once a session has started', () => {
      expect(isTransitionAllowed(Action.CANCEL_REQUEST, S.IN_SESSION)).toBe(false);
      expect(isTransitionAllowed(Action.CANCEL_REQUEST, S.ENDED)).toBe(false);
    });

    it('no transition leaves a terminal state (SUMMARIZED / CANCELLED)', () => {
      const triggers: TransitionTrigger[] = [
        Action.CLAIM_CASE,
        Action.START_CONSULTATION,
        Action.END_CONSULTATION,
        Action.FINALIZE_SUMMARY,
        Action.CANCEL_REQUEST,
        ENQUEUE,
        REQUEUE,
        REASSIGN,
      ];
      for (const terminal of TERMINAL_STATES) {
        for (const trigger of triggers) {
          expect(isTransitionAllowed(trigger, terminal)).toBe(false);
        }
      }
    });
  });

  it('is deny-by-default for a non-transition action', () => {
    expect(isTransitionAllowed(Action.VIEW_QUEUE, S.QUEUED)).toBe(false);
    expect(transitionFor(Action.VIEW_QUEUE)).toBeUndefined();
  });
});
