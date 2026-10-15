import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ConsultationState, Role } from '@prisma/client';
import { AUDIT_EVENTS } from '../audit/audit-events';
import { AuditService } from '../audit/audit.service';
import { Action } from '../common/authz/authorization-matrix';
import { ActingUser, authorizeConsultationAction } from '../common/authz/policy';
import { SummaryFinalizedException } from '../common/errors/domain-exceptions';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { DraftSummaryDto } from './dto/draft-summary.dto';

export interface SummaryView {
  consultationId: string;
  content: string;
  draftedBy: string;
  finalizedBy: string | null;
  finalizedAt: Date | null;
  finalized: boolean;
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

    const summary = await this.prisma.summary.upsert({
      where: { consultationId },
      create: { consultationId, draftedBy: user.id, content: dto.content },
      update: { content: dto.content, draftedBy: user.id },
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

    await this.audit.record({
      actorId: user.id,
      eventType: AUDIT_EVENTS.SUMMARY_FINALIZED,
      consultationId,
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
   * View the summary. Assigned clinician sees drafts; the patient owner sees it
   * only once finalized (FR-6). Admins are denied by the authorization matrix.
   */
  async get(user: ActingUser, consultationId: string): Promise<SummaryView> {
    const consultation = await this.loadConsultationOr404(consultationId);
    authorizeConsultationAction(user, consultation, Action.VIEW_SUMMARY);

    const summary = await this.prisma.summary.findUnique({ where: { consultationId } });
    // Hide a draft (and even its existence) from the patient until it is finalized.
    if (!summary || (user.role === Role.PATIENT && !summary.finalizedAt)) {
      throw new NotFoundException('Summary not available');
    }
    return this.toView(summary);
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

  private toView(summary: {
    consultationId: string;
    content: string;
    draftedBy: string;
    finalizedBy: string | null;
    finalizedAt: Date | null;
  }): SummaryView {
    return {
      consultationId: summary.consultationId,
      content: summary.content,
      draftedBy: summary.draftedBy,
      finalizedBy: summary.finalizedBy,
      finalizedAt: summary.finalizedAt,
      finalized: summary.finalizedAt != null,
    };
  }
}
