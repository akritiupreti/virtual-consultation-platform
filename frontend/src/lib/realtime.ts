/**
 * Thin socket.io client for the live triage queue and consultation rooms
 * (docs/api-spec.md §WebSocket API). A single shared connection is authenticated
 * with the current JWT; the hooks below subscribe/join and reconcile from the
 * authoritative REST state on (re)connect. Screens keep a slower polling fallback
 * so they still work if the socket is unavailable.
 */
import { useEffect, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import { BASE_URL, getToken, Message } from './api';

let socket: Socket | null = null;
let socketToken: string | null = null;

/** Get (or lazily create) the shared socket for the current token. */
export function getRealtimeSocket(): Socket | null {
  const token = getToken();
  if (!token) {
    return null;
  }
  if (socket && socketToken === token) {
    return socket;
  }
  // Token changed (new login) — drop the old connection first.
  if (socket) {
    socket.disconnect();
  }
  socketToken = token;
  socket = io(BASE_URL, {
    auth: { token },
    transports: ['websocket'],
    reconnection: true,
    reconnectionDelay: 1000,
  });
  return socket;
}

/** Tear down the connection on logout. */
export function disconnectRealtime(): void {
  if (socket) {
    socket.disconnect();
    socket = null;
    socketToken = null;
  }
}

export interface PresenceParticipant {
  userId: string;
  online: boolean;
}

/** Subscribe to live triage-queue changes; `onChange` re-fetches the queue. */
export function useQueueUpdates(onChange: () => void): void {
  const cb = useRef(onChange);
  cb.current = onChange;

  useEffect(() => {
    const s = getRealtimeSocket();
    if (!s) {
      return;
    }
    // (Re)subscribe on every connect so a reconnect reconciles from the server.
    const subscribe = (): void => {
      s.emit('subscribe:queue');
    };
    const handler = (): void => cb.current();
    if (s.connected) {
      subscribe();
    }
    s.on('connect', subscribe);
    s.on('queue:updated', handler);
    return () => {
      s.off('connect', subscribe);
      s.off('queue:updated', handler);
    };
  }, []);
}

/**
 * Live updates for a patient's own consultations (position + state). The server
 * auto-joins each user to their personal room on connect, so no explicit
 * subscription is needed; `onChange` re-fetches `/consultations/mine`.
 */
export function usePatientUpdates(onChange: () => void): void {
  const cb = useRef(onChange);
  cb.current = onChange;

  useEffect(() => {
    const s = getRealtimeSocket();
    if (!s) {
      return;
    }
    const handler = (): void => cb.current();
    s.on('position:updated', handler);
    s.on('consultation:updated', handler);
    return () => {
      s.off('position:updated', handler);
      s.off('consultation:updated', handler);
    };
  }, []);
}

/**
 * A clinician's own assigned cases changed state (claimed, started, ended, cancelled
 * by the patient, re-queued, finalized). The server also sends `consultation:updated`
 * to the assigned clinician's personal room (ADR-0027), so "My consultations"
 * reconciles without polling; `onChange` re-fetches the list.
 */
export function useAssignedUpdates(onChange: () => void): void {
  const cb = useRef(onChange);
  cb.current = onChange;

  useEffect(() => {
    const s = getRealtimeSocket();
    if (!s) {
      return;
    }
    const handler = (): void => cb.current();
    s.on('consultation:updated', handler);
    s.on('summary:updated', handler);
    return () => {
      s.off('consultation:updated', handler);
      s.off('summary:updated', handler);
    };
  }, []);
}

export type SummaryUpdateReason = 'drafted' | 'changes_requested' | 'finalized' | 'ended';

export interface SummaryUpdated {
  consultationId: string;
  reason: SummaryUpdateReason;
}

/**
 * A summary changed or a case entered the sign-off window (ADR-0027). Delivered to
 * every doctor (the sign-off room, joined on connect) and to the case's assigned
 * clinician. Content-free: `onUpdate` reconciles via REST.
 */
export function useSummaryUpdates(onUpdate: (payload: SummaryUpdated) => void): void {
  const cb = useRef(onUpdate);
  cb.current = onUpdate;

  useEffect(() => {
    const s = getRealtimeSocket();
    if (!s) {
      return;
    }
    const handler = (payload: SummaryUpdated): void => cb.current(payload);
    s.on('summary:updated', handler);
    return () => {
      s.off('summary:updated', handler);
    };
  }, []);
}

export interface SummaryChangesRequested {
  consultationId: string;
  note?: string;
}

/**
 * Clinician-side: the drafter is notified when a reviewing doctor returns their
 * summary draft for changes (ADR-0024). The server emits `summary:changes-requested`
 * only to the recipient's own personal room (auto-joined on connect), so no explicit
 * subscription is needed and it arrives on whatever screen the clinician is viewing.
 */
export function useSummaryChangeRequests(
  onRequest: (payload: SummaryChangesRequested) => void,
): void {
  const cb = useRef(onRequest);
  cb.current = onRequest;

  useEffect(() => {
    const s = getRealtimeSocket();
    if (!s) {
      return;
    }
    const handler = (payload: SummaryChangesRequested): void => cb.current(payload);
    s.on('summary:changes-requested', handler);
    return () => {
      s.off('summary:changes-requested', handler);
    };
  }, []);
}

export interface RoomHandlers {
  onMessage?: (message: Message) => void;
  onConsultationUpdated?: () => void;
  onPresence?: (participants: PresenceParticipant[]) => void;
  onAttachment?: () => void;
}

/** Join a consultation room and receive live messages / state / presence. */
export function useConsultationRoom(id: string, handlers: RoomHandlers): void {
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    const s = getRealtimeSocket();
    if (!s || !id) {
      return;
    }
    // Join on every connect so a reconnect rejoins and reconciles.
    const join = (): void => {
      s.emit('join:consultation', { consultationId: id });
    };
    // A socket is in several rooms at once (its personal room also carries state
    // changes for the user's other cases), so only react to this consultation.
    // Payloads without an id are treated as ours, for older/simpler emitters.
    const mine = (payload?: { consultationId?: string }): boolean =>
      !payload?.consultationId || payload.consultationId === id;
    const onMessage = (payload: { consultationId?: string; message: Message }): void => {
      if (mine(payload)) {
        ref.current.onMessage?.(payload.message);
      }
    };
    const onUpdated = (payload?: { consultationId?: string }): void => {
      if (mine(payload)) {
        ref.current.onConsultationUpdated?.();
      }
    };
    const onPresence = (payload: {
      consultationId?: string;
      participants: PresenceParticipant[];
    }): void => {
      if (mine(payload)) {
        ref.current.onPresence?.(payload.participants);
      }
    };
    const onAttachment = (payload: { consultationId?: string }): void => {
      if (mine(payload)) {
        ref.current.onAttachment?.();
      }
    };

    if (s.connected) {
      join();
    }
    s.on('connect', join);
    s.on('message:created', onMessage);
    s.on('consultation:updated', onUpdated);
    s.on('presence:updated', onPresence);
    s.on('attachment:created', onAttachment);
    return () => {
      s.emit('leave:consultation', { consultationId: id });
      s.off('connect', join);
      s.off('message:created', onMessage);
      s.off('consultation:updated', onUpdated);
      s.off('presence:updated', onPresence);
      s.off('attachment:created', onAttachment);
    };
  }, [id]);
}
