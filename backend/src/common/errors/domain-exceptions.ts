import { ConflictException, ForbiddenException } from '@nestjs/common';

/**
 * Domain exceptions mapped to the HTTP semantics in docs/state-machine.md:
 * state violations → 409 Conflict, role/ownership violations → 403 Forbidden.
 */

/** A transition attempted from a state where the action is not legal → 409. */
export class IllegalTransitionException extends ConflictException {
  constructor(action: string, state: string) {
    super(`Action "${action}" is not allowed from state ${state}`);
  }
}

/** Lost the DB-atomic claim race (someone else claimed it first) → 409 (ADR-0003). */
export class AlreadyClaimedException extends ConflictException {
  constructor() {
    super('Consultation has already been claimed');
  }
}

/** Clinician is at their active-consultation cap (FR-10) → 409. */
export class ClaimCapReachedException extends ConflictException {
  constructor(max: number) {
    super(`Clinician already has the maximum of ${max} active consultation(s)`);
  }
}

/** Role or ownership check failed → 403. */
export class ForbiddenActionException extends ForbiddenException {
  constructor(reason = 'You are not allowed to perform this action') {
    super(reason);
  }
}

/** Attempt to edit a finalized (immutable) summary → 409. */
export class SummaryFinalizedException extends ConflictException {
  constructor() {
    super('A finalized summary is immutable; corrections are added as addendums');
  }
}
