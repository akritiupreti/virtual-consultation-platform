import { Injectable } from '@nestjs/common';
import { ConsultationState } from '@prisma/client';
import type { Server } from 'socket.io';
import { PrismaService } from '../prisma/prisma.service';
import {
  consultationRoom,
  ConsultationUpdatedPayload,
  MessageCreatedPayload,
  PositionUpdatedPayload,
  QUEUE_ROOM,
  QueueChangeReason,
  SIGNOFF_ROOM,
  SummaryUpdatedPayload,
  SummaryUpdateReason,
  userRoom,
  WS_EVENTS,
} from './events';

/**
 * The real-time publisher. Domain services (consultations, messaging, summaries)
 * and the claim-TTL sweeper call these methods after they have committed a change
 * to PostgreSQL — the DB is authoritative; this layer only fans the news out
 * (ADR-0004/0007). When no socket server is attached (e.g. a REST-only test)
 * every emit is a safe no-op.
 */
@Injectable()
export class RealtimeService {
  private server: Server | null = null;

  constructor(private readonly prisma: PrismaService) {}

  /** Wired by the gateway once socket.io has initialized. */
  setServer(server: Server): void {
    this.server = server;
  }

  /**
   * Force every live socket of a user to disconnect — used when an account is
   * deactivated so an already-issued JWT cannot keep a session open (FR-24/25).
   * Targets the user's personal room, so every open tab is closed. A no-op when no
   * socket server is attached.
   */
  disconnectUser(userId: string): void {
    this.server?.in(userRoom(userId)).disconnectSockets(true);
  }

  /** New message into the private consultation room (participants only). */
  broadcastMessage(payload: MessageCreatedPayload): void {
    this.server
      ?.to(consultationRoom(payload.consultationId))
      .emit(WS_EVENTS.MESSAGE_CREATED, payload);
  }

  /**
   * A consultation's summary changed, or a case entered the sign-off window
   * (ADR-0022). Sent to the assigned clinician's personal room (their "My
   * consultations" list and open editor) and to the doctors' sign-off room (the
   * worklist and any open review), never to the patient — a draft is not theirs to
   * see. The payload is an id + reason only; recipients reconcile via REST.
   */
  notifySummaryUpdated(update: {
    consultationId: string;
    claimedBy: string | null;
    reason: SummaryUpdateReason;
  }): void {
    const payload: SummaryUpdatedPayload = {
      consultationId: update.consultationId,
      reason: update.reason,
    };
    // One emit across both rooms so a doctor who is also the assignee gets it once.
    const rooms = update.claimedBy ? [SIGNOFF_ROOM, userRoom(update.claimedBy)] : [SIGNOFF_ROOM];
    this.server?.to(rooms).emit(WS_EVENTS.SUMMARY_UPDATED, payload);
  }

  /**
   * A consultation's state changed. Emitted to the consultation room (both
   * participants), to the patient's personal room so their status view reconciles
   * even when they are not inside the room, and to the assigned clinician's
   * personal room so their "My consultations" list does too (ADR-0022). The
   * payload is an id + state, which every recipient may already see.
   */
  broadcastConsultationUpdated(consultation: {
    id: string;
    patientId: string;
    state: ConsultationState;
    /** The clinician the case is (or was, before a requeue) assigned to. */
    claimedBy?: string | null;
  }): void {
    const payload: ConsultationUpdatedPayload = {
      consultationId: consultation.id,
      state: consultation.state,
    };
    const rooms = [consultationRoom(consultation.id), userRoom(consultation.patientId)];
    if (consultation.claimedBy) {
      rooms.push(userRoom(consultation.claimedBy));
    }
    // A single emit to several rooms delivers once per socket, so a clinician who
    // is both in the room and in their personal room is not notified twice.
    this.server?.to(rooms).emit(WS_EVENTS.CONSULTATION_UPDATED, payload);
  }

  /**
   * The queue changed (FR-18/C18). Signals clinician subscribers to re-fetch the
   * queue, then recomputes every waiting patient's "N ahead" from the DB and
   * pushes it to them (C2/FR-4).
   */
  async notifyQueueChanged(reason: QueueChangeReason, consultationId?: string): Promise<void> {
    this.server?.to(QUEUE_ROOM).emit(WS_EVENTS.QUEUE_UPDATED, { reason, consultationId });
    await this.recomputeQueuePositions();
  }

  /**
   * Recompute positions for all QUEUED consultations in one ordered read (serving
   * order = priority tier then FIFO) and push each patient their own position.
   */
  async recomputeQueuePositions(): Promise<void> {
    const queued = await this.prisma.consultation.findMany({
      where: { state: ConsultationState.QUEUED },
      orderBy: [{ priority: 'desc' }, { enqueuedAt: 'asc' }],
      select: { id: true, patientId: true },
    });

    queued.forEach((row, index) => {
      const payload: PositionUpdatedPayload = {
        consultationId: row.id,
        state: ConsultationState.QUEUED,
        position: index,
      };
      this.server?.to(userRoom(row.patientId)).emit(WS_EVENTS.POSITION_UPDATED, payload);
    });
  }
}
