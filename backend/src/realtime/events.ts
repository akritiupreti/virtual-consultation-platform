import { ConsultationState } from '@prisma/client';

/**
 * WebSocket event + room contract (docs/api-spec.md §WebSocket API). This is the
 * single definition of channel names and payload shapes shared by the gateway and
 * the publisher service. Payloads deliberately carry no clinical content beyond
 * what the authorization matrix already permits the room's members to see
 * (ADR-0009, invariants 3 & 6): queue/position events are ids + states + counts;
 * message bodies travel only inside the private per-consultation room.
 */
export const WS_EVENTS = {
  // ── client → server ──────────────────────────────────────────────────────
  /** Clinician subscribes to the live triage queue. */
  SUBSCRIBE_QUEUE: 'subscribe:queue',
  /** Participant joins a consultation room. */
  JOIN_CONSULTATION: 'join:consultation',
  /** Participant leaves a consultation room. */
  LEAVE_CONSULTATION: 'leave:consultation',

  // ── server → client ──────────────────────────────────────────────────────
  /** The triage queue changed; subscribers reconcile via GET /consultations/queue. */
  QUEUE_UPDATED: 'queue:updated',
  /** A consultation's state changed; members reconcile via GET /consultations/:id. */
  CONSULTATION_UPDATED: 'consultation:updated',
  /** A new message in a consultation room (participants only). */
  MESSAGE_CREATED: 'message:created',
  /** A patient's live "N ahead" position changed. */
  POSITION_UPDATED: 'position:updated',
  /** Presence of a consultation's participants changed. */
  PRESENCE_UPDATED: 'presence:updated',
} as const;

/** Shared triage-queue room — clinicians only. */
export const QUEUE_ROOM = 'queue';
/** Per-consultation room — the two participants only. */
export const consultationRoom = (id: string): string => `consultation:${id}`;
/** Per-user personal room — carries a patient's own position/state updates. */
export const userRoom = (userId: string): string => `user:${userId}`;

/** Why the queue changed (FR-18 / C18 triggers). No clinical content. */
export type QueueChangeReason =
  | 'enqueued'
  | 'priority_changed'
  | 'claimed'
  | 'requeued'
  | 'reassigned'
  | 'completed'
  | 'cancelled'
  | 'state_changed';

export interface QueueUpdatedPayload {
  reason: QueueChangeReason;
  /** The consultation that triggered the change (opaque id; not PII). */
  consultationId?: string;
}

export interface ConsultationUpdatedPayload {
  consultationId: string;
  state: ConsultationState;
}

export interface MessageCreatedPayload {
  consultationId: string;
  message: { id: string; senderId: string; body: string; createdAt: string };
}

export interface PositionUpdatedPayload {
  consultationId: string;
  state: ConsultationState;
  /** Cases ahead in the queue, or null when not QUEUED. */
  position: number | null;
}

export interface PresenceUpdatedPayload {
  consultationId: string;
  participants: Array<{ userId: string; online: boolean }>;
}

/** Ack returned to a client for subscribe/join requests. */
export interface SubscriptionAck {
  ok: boolean;
  error?: 'unauthorized' | 'forbidden' | 'not_found' | 'bad_request';
}
