import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConsultationState } from '@prisma/client';
import type { Server } from 'socket.io';
import { PrismaService } from '../prisma/prisma.service';
import {
  AttachmentCreatedPayload,
  consultationRoom,
  ConsultationUpdatedPayload,
  MessageCreatedPayload,
  PositionUpdatedPayload,
  QUEUE_ROOM,
  QueueChangeReason,
  SIGNOFF_ROOM,
  SummaryChangesRequestedPayload,
  SummaryUpdatedPayload,
  SummaryUpdateReason,
  userRoom,
  WS_EVENTS,
} from './events';
import { OptionalRedis, REDIS_CLIENT } from './redis.provider';

/** Cache-aside TTL for queue positions (ADR-0004 — cached positions). */
const POSITION_CACHE_TTL_SECONDS = 30;
const positionKey = (consultationId: string): string => `queuepos:${consultationId}`;

/**
 * The real-time publisher. Domain services (consultations, messaging, summaries)
 * and the claim-TTL sweeper call these methods after they have committed a change
 * to PostgreSQL — the DB is authoritative; this layer only fans the news out
 * (ADR-0004/0005). Cross-instance fan-out is handled by the socket.io Redis
 * adapter (ADR-0009); when no socket server is attached (e.g. a REST-only test)
 * every emit is a safe no-op.
 */
@Injectable()
export class RealtimeService {
  private readonly log = new Logger(RealtimeService.name);
  private server: Server | null = null;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: OptionalRedis,
  ) {}

  /** Wired by the gateway once socket.io has initialized. */
  setServer(server: Server): void {
    this.server = server;
  }

  /**
   * Force every live socket of a user to disconnect — used when an account is
   * deactivated so an already-issued JWT cannot keep a session open (FR-24/25).
   * Targets the user's personal room, so it reaches the user across instances via
   * the Redis adapter. A no-op when no socket server is attached.
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
   * A reviewing doctor asked the drafter to revise a summary (ADR-0024). Sent only
   * to the drafting clinician's personal room so the optional note reaches no one
   * else, and so it arrives even though a sign-off doctor is not in the room. A
   * no-op when no socket server is attached.
   */
  notifySummaryChangesRequested(draftedBy: string, payload: SummaryChangesRequestedPayload): void {
    this.server?.to(userRoom(draftedBy)).emit(WS_EVENTS.SUMMARY_CHANGES_REQUESTED, payload);
  }

  /**
   * A consultation's summary changed, or a case entered the sign-off window
   * (ADR-0027). Sent to the assigned clinician's personal room (their "My
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

  /** A file was attached; room members re-fetch the (authorized) attachment list. */
  notifyAttachmentCreated(consultationId: string): void {
    const payload: AttachmentCreatedPayload = { consultationId };
    this.server?.to(consultationRoom(consultationId)).emit(WS_EVENTS.ATTACHMENT_CREATED, payload);
  }

  /** A file was removed; room members re-fetch the list (content-free, ADR-0028). */
  notifyAttachmentRemoved(consultationId: string): void {
    const payload: AttachmentCreatedPayload = { consultationId };
    this.server?.to(consultationRoom(consultationId)).emit(WS_EVENTS.ATTACHMENT_REMOVED, payload);
  }

  /**
   * A consultation's state changed. Emitted to the consultation room (both
   * participants), to the patient's personal room so their status view reconciles
   * even when they are not inside the room, and to the assigned clinician's
   * personal room so their "My consultations" list does too (ADR-0027). The
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
   * order = priority tier then FIFO), cache them, and push each patient their own
   * position. PostgreSQL stays authoritative; the cache is a best-effort read path.
   */
  async recomputeQueuePositions(): Promise<void> {
    const queued = await this.prisma.consultation.findMany({
      where: { state: ConsultationState.QUEUED },
      orderBy: [{ priority: 'desc' }, { enqueuedAt: 'asc' }],
      select: { id: true, patientId: true },
    });

    await Promise.all(
      queued.map(async (row, index) => {
        await this.cachePosition(row.id, index);
        const payload: PositionUpdatedPayload = {
          consultationId: row.id,
          state: ConsultationState.QUEUED,
          position: index,
        };
        this.server?.to(userRoom(row.patientId)).emit(WS_EVENTS.POSITION_UPDATED, payload);
      }),
    );
  }

  /** Best-effort cached position read (DB remains the source of truth on a miss). */
  async getCachedPosition(consultationId: string): Promise<number | null> {
    if (!this.redis) {
      return null;
    }
    try {
      const value = await this.redis.get(positionKey(consultationId));
      return value == null ? null : Number(value);
    } catch (err) {
      this.log.warn(`position cache read degraded: ${(err as Error).message}`);
      return null;
    }
  }

  private async cachePosition(consultationId: string, position: number): Promise<void> {
    if (!this.redis) {
      return;
    }
    try {
      await this.redis.set(positionKey(consultationId), position, 'EX', POSITION_CACHE_TTL_SECONDS);
    } catch (err) {
      this.log.warn(`position cache write degraded: ${(err as Error).message}`);
    }
  }
}
