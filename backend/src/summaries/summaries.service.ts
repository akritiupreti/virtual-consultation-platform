import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ConsultationState, Role } from '@prisma/client';
import { AUDIT_EVENTS } from '../audit/audit-events';
import { AuditService } from '../audit/audit.service';
import { Action } from '../common/authz/authorization-matrix';
import { ActingUser, authorizeConsultationAction } from '../common/authz/policy';
import { SummaryFinalizedException } from '../common/errors/domain-exceptions';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { AddAddendumDto } from './dto/add-addendum.dto';
import { DraftSummaryDto } from './dto/draft-summary.dto';
import { RequestSummaryChangesDto } from './dto/request-summary-changes.dto';

export interface AddendumView {
  id: string;
  authorId: string;
  content: string;
  createdAt: Date;
}

export interface SummaryView {
  consultationId: string;
  content: string;
  draftedBy: string;
  finalizedBy: string | null;
  finalizedAt: Date | null;
  finalized: boolean;
  /**
   * When a doctor last returned this draft for changes, and their note — a durable
   * "please revise" signal for the drafter, cleared on the next draft (ADR-0025).
   * Null once revised or if changes were never requested.
   */
  changesRequestedAt: Date | null;
  changesRequestedNote: string | null;
  /** Append-only corrections, oldest first (FR-13, C5). */
  addenda: AddendumView[];
}

const DRAFTABLE_STATES: ConsultationState[] = [
  ConsultationState.IN_SESSION,
  ConsultationState.ENDED,
];

@Injectable()
export class SummariesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly realtime: RealtimeService,
  ) {}

  /** Assigned clinician drafts (or revises) the summary. A finalized summary is immutable. */
  async draft(
    user: ActingUser,
    consultationId: string,
    dto: DraftSummaryDto,
  ): Promise<SummaryView> {
    const consultation = await this.loadConsultationOr404(consultationId);
    authorizeConsultationAction(user, consultation, Action.DRAFT_SUMMARY);

    if (!DRAFTABLE_STATES.includes(consultation.state)) {
      throw new ConflictException('A summary can only be drafted during or after a session');
    }

    const existing = await this.prisma.summary.findUnique({ where: { consultationId } });
    if (existing?.finalizedAt) {
      throw new SummaryFinalizedException();
    }

    // Saving a (re)draft clears any outstanding "please revise" request — the
    // drafter has acted, so the doctor's badge/note is no longer pending (ADR-0025).
    const summary = await this.prisma.summary.upsert({
      where: { consultationId },
      create: { consultationId, draftedBy: user.id, content: dto.content },
      update: {
        content: dto.content,
        draftedBy: user.id,
        changesRequestedAt: null,
        changesRequestedNote: null,
      },
    });

    await this.audit.record({
      actorId: user.id,
      eventType: AUDIT_EVENTS.SUMMARY_DRAFTED,
      consultationId,
    });

    return this.toView(summary);
  }

  /**
   * Doctor-only finalize (FR-13). Transitions ENDED → SUMMARIZED and stamps the
   * finalizer; the summary becomes immutable. Both writes commit in one transaction.
   */
  async finalize(user: ActingUser, consultationId: string): Promise<SummaryView> {
    const consultation = await this.loadConsultationOr404(consultationId);
    authorizeConsultationAction(user, consultation, Action.FINALIZE_SUMMARY);

    const existing = await this.prisma.summary.findUnique({ where: { consultationId } });
    if (!existing) {
      throw new ConflictException('There is no drafted summary to finalize');
    }
    if (existing.finalizedAt) {
      throw new SummaryFinalizedException();
    }

    const now = new Date();
    const summary = await this.prisma.$transaction(async (tx) => {
      const finalized = await tx.summary.update({
        where: { consultationId },
        data: { finalizedBy: user.id, finalizedAt: now },
      });
      const moved = await tx.consultation.updateMany({
        where: { id: consultationId, state: ConsultationState.ENDED },
        data: { state: ConsultationState.SUMMARIZED, version: { increment: 1 } },
      });
      if (moved.count === 0) {
        // State changed under us — abort the transaction.
        throw new ConflictException('Consultation is no longer in a finalizable state');
      }
      return finalized;
    });

    // actorId is the finalizing doctor; draftedBy records who authored the draft,
    // so a nurse-drafts → doctor-signs-off handoff is auditable end-to-end as
    // who/what/when (never the summary text — invariants 5 & 6).
    await this.audit.record({
      actorId: user.id,
      eventType: AUDIT_EVENTS.SUMMARY_FINALIZED,
      consultationId,
      metadata: { draftedBy: existing.draftedBy },
    });
    // Notify the room + the patient that the summary is finalized (SUMMARIZED).
    this.realtime.broadcastConsultationUpdated({
      id: consultationId,
      patientId: consultation.patientId,
      state: ConsultationState.SUMMARIZED,
    });

    return this.toView(summary);
  }

  /**
   * A reviewing doctor returns a drafted summary to the drafter to revise instead
   * of finalizing one they disagree with (ADR-0024). Doctor-only (matrix), not
   * tied to the assigned clinician — exactly like finalize, so it works on a
   * nurse-run case. No state transition: the case stays ENDED so the assigned
   * clinician can re-draft via DRAFT_SUMMARY, then a doctor finalizes.
   *
   * Audited as who/what/when — the drafter who must act — never the doctor's note,
   * which is delivered to that drafter in real time only (invariant 6).
   */
  async requestChanges(
    user: ActingUser,
    consultationId: string,
    dto: RequestSummaryChangesDto,
  ): Promise<SummaryView> {
    const consultation = await this.loadConsultationOr404(consultationId);
    authorizeConsultationAction(user, consultation, Action.REQUEST_SUMMARY_CHANGES);

    const summary = await this.prisma.summary.findUnique({ where: { consultationId } });
    if (!summary) {
      throw new ConflictException('There is no drafted summary to return for changes');
    }
    if (summary.finalizedAt) {
      // Already signed and immutable — corrections go through an addendum (FR-13).
      throw new SummaryFinalizedException();
    }
    if (consultation.state !== ConsultationState.ENDED) {
      throw new ConflictException(
        'Changes can only be requested while a case is awaiting sign-off',
      );
    }

    // Persist a durable "please revise" marker + the note so the drafter still sees
    // it if they were offline for the live nudge; cleared when they next draft
    // (ADR-0025). The note is feedback for the drafter, never logged (invariant 6).
    const updated = await this.prisma.summary.update({
      where: { consultationId },
      data: { changesRequestedAt: new Date(), changesRequestedNote: dto.note ?? null },
    });

    await this.audit.record({
      actorId: user.id,
      eventType: AUDIT_EVENTS.SUMMARY_CHANGES_REQUESTED,
      consultationId,
      metadata: { draftedBy: summary.draftedBy },
    });

    // Also nudge the drafting clinician live. The optional note travels here too
    // (to their personal room) — never into the audit log (invariant 6).
    this.realtime.notifySummaryChangesRequested(summary.draftedBy, {
      consultationId,
      note: dto.note,
    });

    return this.toView(updated);
  }

  /**
   * View the summary. Assigned clinician sees drafts; the patient owner sees it
   * only once finalized (FR-6). Admins are denied by the authorization matrix.
   * Finalized summaries include their append-only addenda (FR-13).
   */
  async get(user: ActingUser, consultationId: string): Promise<SummaryView> {
    const consultation = await this.loadConsultationOr404(consultationId);
    // Load the summary before the authz check so the policy can grant the
    // finalizing doctor continued read access via `finalizedBy` (ADR-0023). The
    // role → state → ownership check still runs first, so a disallowed caller
    // gets 403 ahead of the not-found below, exactly as before.
    const summary = await this.prisma.summary.findUnique({
      where: { consultationId },
      include: { addenda: { orderBy: { createdAt: 'asc' } } },
    });
    authorizeConsultationAction(
      user,
      { ...consultation, finalizedBy: summary?.finalizedBy ?? null },
      Action.VIEW_SUMMARY,
    );

    // Hide a draft (and even its existence) from the patient until it is finalized.
    if (!summary || (user.role === Role.PATIENT && !summary.finalizedAt)) {
      throw new NotFoundException('Summary not available');
    }
    return this.toView(summary, summary.addenda);
  }

  /**
   * Append a correction to a FINALIZED summary (FR-13, C5). The summary itself is
   * never mutated — corrections are append-only addendums, preserving an auditable
   * record. Clinicians only (matrix: ADD_ADDENDUM); admins are denied. Audited as
   * SUMMARY_ADDENDUM_ADDED (who/what/when only — never the addendum text).
   */
  async addAddendum(
    user: ActingUser,
    consultationId: string,
    dto: AddAddendumDto,
  ): Promise<SummaryView> {
    const consultation = await this.loadConsultationOr404(consultationId);
    authorizeConsultationAction(user, consultation, Action.ADD_ADDENDUM);

    if (consultation.state !== ConsultationState.SUMMARIZED) {
      throw new ConflictException('Addendums can only be added to a finalized summary');
    }

    const summary = await this.prisma.summary.findUnique({ where: { consultationId } });
    if (!summary || !summary.finalizedAt) {
      throw new ConflictException('There is no finalized summary to amend');
    }

    await this.prisma.addendum.create({
      data: { summaryId: summary.id, authorId: user.id, content: dto.content },
    });
    await this.audit.record({
      actorId: user.id,
      eventType: AUDIT_EVENTS.SUMMARY_ADDENDUM_ADDED,
      consultationId,
      metadata: { summaryId: summary.id },
    });

    const addenda = await this.prisma.addendum.findMany({
      where: { summaryId: summary.id },
      orderBy: { createdAt: 'asc' },
    });
    return this.toView(summary, addenda);
  }

  private async loadConsultationOr404(
    id: string,
  ): Promise<{ patientId: string; claimedBy: string | null; state: ConsultationState }> {
    const consultation = await this.prisma.consultation.findUnique({
      where: { id },
      select: { patientId: true, claimedBy: true, state: true },
    });
    if (!consultation) {
      throw new NotFoundException('Consultation not found');
    }
    return consultation;
  }

  private toView(
    summary: {
      consultationId: string;
      content: string;
      draftedBy: string;
      finalizedBy: string | null;
      finalizedAt: Date | null;
      changesRequestedAt?: Date | null;
      changesRequestedNote?: string | null;
    },
    addenda: AddendumView[] = [],
  ): SummaryView {
    return {
      consultationId: summary.consultationId,
      content: summary.content,
      draftedBy: summary.draftedBy,
      finalizedBy: summary.finalizedBy,
      finalizedAt: summary.finalizedAt,
      finalized: summary.finalizedAt != null,
      changesRequestedAt: summary.changesRequestedAt ?? null,
      changesRequestedNote: summary.changesRequestedNote ?? null,
      addenda: addenda.map((a) => ({
        id: a.id,
        authorId: a.authorId,
        content: a.content,
        createdAt: a.createdAt,
      })),
    };
  }
}
