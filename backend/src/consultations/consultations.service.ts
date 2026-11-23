import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Consultation, ConsultationState, Prisma, Priority } from '@prisma/client';
import { AUDIT_EVENTS } from '../audit/audit-events';
import { AuditService } from '../audit/audit.service';
import { Action } from '../common/authz/authorization-matrix';
import { ActingUser, authorizeConsultationAction } from '../common/authz/policy';
import {
  AlreadyClaimedException,
  ClaimCapReachedException,
  IllegalTransitionException,
} from '../common/errors/domain-exceptions';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { SubmitRequestDto } from './dto/submit-request.dto';

/** Serving order within the queue (higher rank is served first). */
const PRIORITY_RANK: Record<Priority, number> = {
  [Priority.ROUTINE]: 0,
  [Priority.URGENT]: 1,
  [Priority.EMERGENCY]: 2,
};

const CANCELLABLE_STATES: ConsultationState[] = [
  ConsultationState.REQUESTED,
  ConsultationState.QUEUED,
  ConsultationState.CLAIMED,
];

/** Minimal pre-claim view — the only case data visible before claiming (FR-7, C7). */
export interface QueueItem {
  id: string;
  priority: Priority;
  symptomCategory: string;
  severity: number;
  complaintSummary: string;
  enqueuedAt: Date | null;
  waitingSeconds: number;
}

/** A patient's view of their own consultation, including live position. */
export interface MyConsultationView {
  id: string;
  state: ConsultationState;
  priority: Priority;
  createdAt: Date;
  /** A short label of the patient's own chief complaint, so they can tell cases apart. */
  complaintSummary: string;
  /** Count of cases served before this one; null unless QUEUED. */
  position: number | null;
  summaryAvailable: boolean;
}

/**
 * A clinician's view of a case currently assigned to them (claimedBy = self).
 * Enough to find the case again and jump back into its room or summary — not the
 * full clinical narrative (invariant 6: minimise exposure in list views).
 */
export interface AssignedConsultationView {
  id: string;
  state: ConsultationState;
  priority: Priority;
  symptomCategory: string | null;
  complaintSummary: string;
  claimedAt: Date | null;
  startedAt: Date | null;
  endedAt: Date | null;
  /** A summary draft exists — without one an ENDED case cannot reach sign-off (ADR-0009). */
  summaryDrafted: boolean;
  summaryFinalized: boolean;
}

/**
 * A doctor's worklist row for a case awaiting sign-off: a nurse-run case left in
 * ENDED with a drafted-but-unfinalized summary (no doctor participant). Enough to
 * triage and open the case — never the summary text or full narrative (invariant
 * 6: minimise exposure in list views; the doctor reads the detail/summary on open).
 */
export interface PendingSignoffView {
  id: string;
  priority: Priority;
  symptomCategory: string | null;
  complaintSummary: string;
  endedAt: Date | null;
  draftedBy: string;
  draftedAt: Date | null;
}

/**
 * A doctor's own sign-off history row (ADR-0009): a case whose summary this doctor
 * finalized. Minimal, like the worklist — never the summary text. The doctor reads
 * the signed summary itself through VIEW_SUMMARY's finalizing-doctor grant (ADR-0009).
 */
export interface SignedOffView {
  id: string;
  priority: Priority;
  symptomCategory: string | null;
  complaintSummary: string;
  endedAt: Date | null;
  finalizedAt: Date | null;
  draftedBy: string;
}

/** Full participant view (owner or assigned clinician); includes intake. */
export interface ConsultationView {
  id: string;
  state: ConsultationState;
  priority: Priority;
  patientId: string;
  claimedBy: string | null;
  createdAt: Date;
  enqueuedAt: Date | null;
  claimedAt: Date | null;
  startedAt: Date | null;
  endedAt: Date | null;
  intake: {
    chiefComplaint: string;
    symptomCategory: string;
    onsetDuration: string;
    severity: number;
    history: string | null;
    medications: string | null;
    consentAt: Date;
  } | null;
  summaryAvailable: boolean;
  summaryFinalized: boolean;
}

@Injectable()
export class ConsultationsService {
  private readonly maxActive: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly realtime: RealtimeService,
    config: ConfigService,
  ) {
    const configured = Number(config.get<string>('MAX_ACTIVE_CONSULTATIONS_PER_CLINICIAN'));
    this.maxActive = Number.isFinite(configured) && configured > 0 ? configured : 1;
  }

  /**
   * Patient submits intake. Creates the consultation (REQUESTED) and immediately
   * runs the system ENQUEUE transition (REQUESTED → QUEUED) now that intake is
   * valid, consent is captured, and a priority is set — both steps audited in one
   * transaction.
   */
  async submitRequest(user: ActingUser, dto: SubmitRequestDto): Promise<MyConsultationView> {
    const now = new Date();
    const priority = dto.priority ?? Priority.ROUTINE;

    const consultation = await this.prisma.$transaction(async (tx) => {
      const created = await tx.consultation.create({
        data: {
          patientId: user.id,
          state: ConsultationState.REQUESTED,
          priority,
          intake: {
            create: {
              chiefComplaint: dto.chiefComplaint,
              symptomCategory: dto.symptomCategory,
              onsetDuration: dto.onsetDuration,
              severity: dto.severity,
              consentAt: now,
              history: dto.history ?? null,
              medications: dto.medications ?? null,
            },
          },
        },
      });
      await this.audit.record(
        {
          actorId: user.id,
          eventType: AUDIT_EVENTS.CONSULTATION_REQUESTED,
          consultationId: created.id,
          metadata: { priority },
        },
        tx,
      );

      const queued = await tx.consultation.update({
        where: { id: created.id },
        data: {
          state: ConsultationState.QUEUED,
          enqueuedAt: now,
          version: { increment: 1 },
        },
      });
      await this.audit.record(
        {
          actorId: user.id,
          eventType: AUDIT_EVENTS.CONSULTATION_ENQUEUED,
          consultationId: created.id,
          metadata: { from: ConsultationState.REQUESTED, to: ConsultationState.QUEUED, priority },
        },
        tx,
      );
      return queued;
    });

    // Live fan-out: clinicians refresh the queue, waiting patients get a fresh
    // "N ahead".
    await this.realtime.notifyQueueChanged('enqueued', consultation.id);

    return {
      id: consultation.id,
      state: consultation.state,
      priority: consultation.priority,
      createdAt: consultation.createdAt,
      complaintSummary: dto.chiefComplaint.slice(0, 100),
      position: await this.positionOf(consultation),
      summaryAvailable: false,
    };
  }

  /** Triage queue: priority tier first, then FIFO by enqueue time (FR-21). */
  async getQueue(): Promise<QueueItem[]> {
    const rows = await this.prisma.consultation.findMany({
      where: { state: ConsultationState.QUEUED },
      orderBy: [{ priority: 'desc' }, { enqueuedAt: 'asc' }],
      include: {
        intake: {
          select: { symptomCategory: true, severity: true, chiefComplaint: true },
        },
      },
    });

    const now = Date.now();
    return rows.map((row) => ({
      id: row.id,
      priority: row.priority,
      symptomCategory: row.intake?.symptomCategory ?? 'UNKNOWN',
      severity: row.intake?.severity ?? 0,
      // A short complaint summary only — not the full clinical narrative.
      complaintSummary: (row.intake?.chiefComplaint ?? '').slice(0, 100),
      enqueuedAt: row.enqueuedAt,
      waitingSeconds: row.enqueuedAt
        ? Math.max(0, Math.round((now - row.enqueuedAt.getTime()) / 1000))
        : 0,
    }));
  }

  /** A patient's own consultations with a live "N ahead" position for queued ones. */
  async getMine(user: ActingUser): Promise<MyConsultationView[]> {
    const rows = await this.prisma.consultation.findMany({
      where: { patientId: user.id },
      orderBy: { createdAt: 'desc' },
      include: {
        summary: { select: { finalizedAt: true } },
        intake: { select: { chiefComplaint: true } },
      },
    });

    // Resolve "N ahead" for every queued case from a single ordered read of the
    // queue, rather than one COUNT lookup per queued row. This removes an N+1 (a
    // patient may hold several queued cases) and bounds the work to one
    // authoritative query (ADR-0002).
    const positions = rows.some((r) => r.state === ConsultationState.QUEUED)
      ? await this.queuePositions()
      : null;

    return rows.map((row) => ({
      id: row.id,
      state: row.state,
      priority: row.priority,
      createdAt: row.createdAt,
      complaintSummary: (row.intake?.chiefComplaint ?? '').slice(0, 100),
      position: row.state === ConsultationState.QUEUED ? (positions?.get(row.id) ?? null) : null,
      summaryAvailable: row.summary?.finalizedAt != null,
    }));
  }

  /**
   * A clinician's own assigned cases (claimedBy = self), newest claim first, so
   * they can return to a consultation — or its finalised summary — without the
   * URL. Only cases still assigned to them appear; a requeued case (claimedBy
   * cleared by the claim-start TTL, ADR-0007) drops off the list.
   */
  async getAssigned(user: ActingUser): Promise<AssignedConsultationView[]> {
    const rows = await this.prisma.consultation.findMany({
      where: { claimedBy: user.id },
      orderBy: { claimedAt: 'desc' },
      include: {
        intake: { select: { symptomCategory: true, chiefComplaint: true } },
        summary: { select: { finalizedAt: true } },
      },
    });

    return rows.map((row) => ({
      id: row.id,
      state: row.state,
      priority: row.priority,
      symptomCategory: row.intake?.symptomCategory ?? null,
      // A short complaint label only — not the full clinical narrative.
      complaintSummary: (row.intake?.chiefComplaint ?? '').slice(0, 100),
      claimedAt: row.claimedAt,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      summaryDrafted: row.summary != null,
      summaryFinalized: row.summary?.finalizedAt != null,
    }));
  }

  /**
   * A doctor's "pending sign-off" worklist: every case in ENDED that has a
   * drafted-but-unfinalized summary. These are typically nurse-run cases with no
   * doctor participant — the triage queue is QUEUED-only and `getAssigned` filters
   * to the caller's own claims, so without this list a nurse-authored summary can
   * never reach a doctor to be finalized. Oldest-ended first (longest waiting).
   *
   * Role is gated to DOCTOR by the controller + matrix; the rows carry minimal
   * clinical detail only (no summary text), matching the pre-claim/assigned views.
   */
  async getPendingSignoff(): Promise<PendingSignoffView[]> {
    const rows = await this.prisma.consultation.findMany({
      where: {
        state: ConsultationState.ENDED,
        // `is` matches only consultations that HAVE a summary and it is unfinalized,
        // so cases ended without any draft are excluded (nothing to sign off yet).
        summary: { is: { finalizedAt: null } },
      },
      orderBy: { endedAt: 'asc' },
      include: {
        intake: { select: { symptomCategory: true, chiefComplaint: true } },
        summary: { select: { draftedBy: true, createdAt: true } },
      },
    });

    return rows.map((row) => ({
      id: row.id,
      priority: row.priority,
      symptomCategory: row.intake?.symptomCategory ?? null,
      // A short complaint label only — not the full clinical narrative.
      complaintSummary: (row.intake?.chiefComplaint ?? '').slice(0, 100),
      endedAt: row.endedAt,
      draftedBy: row.summary?.draftedBy ?? '',
      draftedAt: row.summary?.createdAt ?? null,
    }));
  }

  /**
   * The calling doctor's completed sign-offs, newest first (ADR-0009): every case
   * whose summary they finalized, whether a nurse or they ran it. Scoped strictly to
   * `finalizedBy = caller` — exactly the summaries ADR-0009 already lets them read —
   * so it widens nothing; it only makes their own final reviews findable again.
   */
  async getSignedOff(user: ActingUser): Promise<SignedOffView[]> {
    const rows = await this.prisma.consultation.findMany({
      where: { summary: { is: { finalizedBy: user.id } } },
      orderBy: { summary: { finalizedAt: 'desc' } },
      take: 200,
      include: {
        intake: { select: { symptomCategory: true, chiefComplaint: true } },
        summary: { select: { draftedBy: true, finalizedAt: true } },
      },
    });

    return rows.map((row) => ({
      id: row.id,
      priority: row.priority,
      symptomCategory: row.intake?.symptomCategory ?? null,
      // A short complaint label only — not the full clinical narrative.
      complaintSummary: (row.intake?.chiefComplaint ?? '').slice(0, 100),
      endedAt: row.endedAt,
      finalizedAt: row.summary?.finalizedAt ?? null,
      draftedBy: row.summary?.draftedBy ?? '',
    }));
  }

  /** Full participant view (patient owner or assigned clinician). */
  async getOne(user: ActingUser, id: string): Promise<ConsultationView> {
    const consultation = await this.prisma.consultation.findUnique({
      where: { id },
      include: { intake: true, summary: { select: { finalizedAt: true } } },
    });
    if (!consultation) {
      throw new NotFoundException('Consultation not found');
    }
    authorizeConsultationAction(user, consultation, Action.VIEW_CONSULTATION);

    return {
      id: consultation.id,
      state: consultation.state,
      priority: consultation.priority,
      patientId: consultation.patientId,
      claimedBy: consultation.claimedBy,
      createdAt: consultation.createdAt,
      enqueuedAt: consultation.enqueuedAt,
      claimedAt: consultation.claimedAt,
      startedAt: consultation.startedAt,
      endedAt: consultation.endedAt,
      intake: consultation.intake
        ? {
            chiefComplaint: consultation.intake.chiefComplaint,
            symptomCategory: consultation.intake.symptomCategory,
            onsetDuration: consultation.intake.onsetDuration,
            severity: consultation.intake.severity,
            history: consultation.intake.history,
            medications: consultation.intake.medications,
            consentAt: consultation.intake.consentAt,
          }
        : null,
      summaryAvailable: consultation.summary != null,
      summaryFinalized: consultation.summary?.finalizedAt != null,
    };
  }

  /**
   * DB-atomic claim (ADR-0003, invariant 2). The conditional UPDATE is the race
   * resolver: exactly the transaction whose update affects one row wins; a zero-row
   * result means someone else already claimed it → 409.
   */
  async claim(user: ActingUser, id: string): Promise<ConsultationView> {
    const existing = await this.loadOr404(id);
    authorizeConsultationAction(user, existing, Action.CLAIM_CASE);

    const result = await this.prisma.consultation.updateMany({
      where: { id, state: ConsultationState.QUEUED, claimedBy: null },
      data: {
        state: ConsultationState.CLAIMED,
        claimedBy: user.id,
        claimedAt: new Date(),
        version: { increment: 1 },
      },
    });
    if (result.count === 0) {
      throw new AlreadyClaimedException();
    }

    await this.audit.record({
      actorId: user.id,
      eventType: AUDIT_EVENTS.CONSULTATION_CLAIMED,
      consultationId: id,
    });
    // The case left the queue (positions shift) and its room state changed.
    this.realtime.broadcastConsultationUpdated({
      id,
      patientId: existing.patientId,
      state: ConsultationState.CLAIMED,
      claimedBy: user.id,
    });
    await this.realtime.notifyQueueChanged('claimed', id);
    return this.getOne(user, id);
  }

  /** Assigned clinician explicitly starts; enforces the active-session cap (FR-10). */
  async start(user: ActingUser, id: string): Promise<ConsultationView> {
    const existing = await this.loadOr404(id);
    authorizeConsultationAction(user, existing, Action.START_CONSULTATION);

    const active = await this.prisma.consultation.count({
      where: { claimedBy: user.id, state: ConsultationState.IN_SESSION },
    });
    if (active >= this.maxActive) {
      throw new ClaimCapReachedException(this.maxActive);
    }

    await this.applyTransition(id, {
      from: [ConsultationState.CLAIMED],
      to: ConsultationState.IN_SESSION,
      extraWhere: { claimedBy: user.id },
      data: { startedAt: new Date() },
      action: Action.START_CONSULTATION,
      currentState: existing.state,
    });

    await this.audit.record({
      actorId: user.id,
      eventType: AUDIT_EVENTS.CONSULTATION_STARTED,
      consultationId: id,
    });
    this.realtime.broadcastConsultationUpdated({
      id,
      patientId: existing.patientId,
      state: ConsultationState.IN_SESSION,
      claimedBy: existing.claimedBy,
    });
    return this.getOne(user, id);
  }

  /** Assigned clinician completes the active session. */
  async complete(user: ActingUser, id: string): Promise<ConsultationView> {
    const existing = await this.loadOr404(id);
    authorizeConsultationAction(user, existing, Action.END_CONSULTATION);

    await this.applyTransition(id, {
      from: [ConsultationState.IN_SESSION],
      to: ConsultationState.ENDED,
      extraWhere: { claimedBy: user.id },
      data: { endedAt: new Date() },
      action: Action.END_CONSULTATION,
      currentState: existing.state,
    });

    await this.audit.record({
      actorId: user.id,
      eventType: AUDIT_EVENTS.CONSULTATION_COMPLETED,
      consultationId: id,
    });
    this.realtime.broadcastConsultationUpdated({
      id,
      patientId: existing.patientId,
      state: ConsultationState.ENDED,
      claimedBy: existing.claimedBy,
    });
    // A case ending with a draft already written enters the doctors' sign-off
    // worklist now, so tell them (ADR-0004).
    this.realtime.notifySummaryUpdated({
      consultationId: id,
      claimedBy: existing.claimedBy,
      reason: 'ended',
    });
    await this.realtime.notifyQueueChanged('completed', id);
    return this.getOne(user, id);
  }

  /** Patient cancels before a session begins (REQUESTED / QUEUED / CLAIMED). */
  async cancel(user: ActingUser, id: string): Promise<ConsultationView> {
    const existing = await this.loadOr404(id);
    authorizeConsultationAction(user, existing, Action.CANCEL_REQUEST);

    await this.applyTransition(id, {
      from: CANCELLABLE_STATES,
      to: ConsultationState.CANCELLED,
      extraWhere: { patientId: user.id },
      action: Action.CANCEL_REQUEST,
      currentState: existing.state,
    });

    await this.audit.record({
      actorId: user.id,
      eventType: AUDIT_EVENTS.CONSULTATION_CANCELLED,
      consultationId: id,
    });
    this.realtime.broadcastConsultationUpdated({
      id,
      patientId: existing.patientId,
      state: ConsultationState.CANCELLED,
      // A patient may cancel a claimed case; its clinician's list must reflect it.
      claimedBy: existing.claimedBy,
    });
    // Cancelling a queued case shifts everyone behind it.
    if (existing.state === ConsultationState.QUEUED) {
      await this.realtime.notifyQueueChanged('cancelled', id);
    }
    return this.getOne(user, id);
  }

  /** Clinician re-triages a queued case (FR-20). */
  async setPriority(
    user: ActingUser,
    id: string,
    priority: Priority,
  ): Promise<{ id: string; state: ConsultationState; priority: Priority }> {
    const existing = await this.loadOr404(id);
    authorizeConsultationAction(user, existing, Action.SET_PRIORITY);
    if (existing.state !== ConsultationState.QUEUED) {
      throw new IllegalTransitionException(Action.SET_PRIORITY, existing.state);
    }

    const updated = await this.prisma.consultation.update({
      where: { id },
      data: { priority, version: { increment: 1 } },
    });
    await this.audit.record({
      actorId: user.id,
      eventType: AUDIT_EVENTS.PRIORITY_CHANGED,
      consultationId: id,
      metadata: { from: existing.priority, to: priority },
    });
    // Re-prioritizing reorders the queue and every waiting patient's position.
    await this.realtime.notifyQueueChanged('priority_changed', id);
    return { id: updated.id, state: updated.state, priority: updated.priority };
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private async loadOr404(id: string): Promise<Consultation> {
    const consultation = await this.prisma.consultation.findUnique({ where: { id } });
    if (!consultation) {
      throw new NotFoundException('Consultation not found');
    }
    return consultation;
  }

  /**
   * Conditional UPDATE guarded by the `from` states (and any ownership filter), so
   * a state change racing in between is caught: a zero-row result means the state
   * moved under us → 409 (optimistic concurrency, same mechanism as the claim).
   */
  private async applyTransition(
    id: string,
    opts: {
      from: ConsultationState[];
      to: ConsultationState;
      extraWhere?: Prisma.ConsultationWhereInput;
      data?: Prisma.ConsultationUpdateManyMutationInput;
      action: string;
      currentState: ConsultationState;
    },
  ): Promise<void> {
    const result = await this.prisma.consultation.updateMany({
      where: { id, state: { in: opts.from }, ...opts.extraWhere },
      data: { state: opts.to, version: { increment: 1 }, ...opts.data },
    });
    if (result.count === 0) {
      throw new IllegalTransitionException(opts.action, opts.currentState);
    }
  }

  /**
   * Serving-order index (0-based "N ahead") of every QUEUED case, read in one
   * ordered query (priority tier then FIFO) — the authoritative basis for a
   * patient's position without a per-row lookup. Used by the multi-row `getMine`;
   * the single-row paths use the `positionOf` count.
   */
  private async queuePositions(): Promise<Map<string, number>> {
    const queued = await this.prisma.consultation.findMany({
      where: { state: ConsultationState.QUEUED },
      orderBy: [{ priority: 'desc' }, { enqueuedAt: 'asc' }],
      select: { id: true },
    });
    return new Map(queued.map((row, index) => [row.id, index]));
  }

  /** "N requests ahead": higher-priority cases, plus same-priority ones enqueued earlier. */
  private async positionOf(consultation: {
    id: string;
    priority: Priority;
    enqueuedAt: Date | null;
  }): Promise<number> {
    const higherTiers = (Object.keys(PRIORITY_RANK) as Priority[]).filter(
      (p) => PRIORITY_RANK[p] > PRIORITY_RANK[consultation.priority],
    );
    return this.prisma.consultation.count({
      where: {
        state: ConsultationState.QUEUED,
        id: { not: consultation.id },
        OR: [
          { priority: { in: higherTiers } },
          {
            priority: consultation.priority,
            enqueuedAt: { lt: consultation.enqueuedAt ?? new Date() },
          },
        ],
      },
    });
  }
}
