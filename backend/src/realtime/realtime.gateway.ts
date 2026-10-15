import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Role } from '@prisma/client';
import type { Server, Socket } from 'socket.io';
import { Action } from '../common/authz/authorization-matrix';
import { ActingUser, authorizeConsultationAction } from '../common/authz/policy';
import { PrismaService } from '../prisma/prisma.service';
import {
  consultationRoom,
  PresenceUpdatedPayload,
  QUEUE_ROOM,
  SubscriptionAck,
  userRoom,
  WS_EVENTS,
} from './events';
import { PresenceService } from './presence.service';
import { RealtimeService } from './realtime.service';

interface JwtPayload {
  sub: string;
  email: string;
  role: string;
}

/**
 * WebSocket gateway for the triage queue and consultation rooms (ADR-0005/0009).
 *
 * Authorization holds over WebSockets exactly as it does over REST (invariants
 * 3 & 4): the JWT is verified on the handshake; subscribing to the queue is
 * clinician-only; joining a consultation room runs the single authorization
 * policy (role → state → ownership), so admins and non-participants are refused.
 * CORS for the handshake is applied by the adapter (see main.ts) where env is
 * loaded, not in this decorator.
 */
@WebSocketGateway()
export class RealtimeGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  private readonly log = new Logger(RealtimeGateway.name);

  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
    private readonly presence: PresenceService,
    private readonly realtime: RealtimeService,
  ) {}

  afterInit(server: Server): void {
    // Give the publisher a handle to the socket server for fan-out.
    this.realtime.setServer(server);
  }

  /** Authenticate on connect; reject (disconnect) an unauthenticated socket. */
  async handleConnection(client: Socket): Promise<void> {
    const user = this.authenticate(client);
    if (!user) {
      client.emit('exception', { ok: false, error: 'unauthorized' } satisfies SubscriptionAck);
      client.disconnect(true);
      return;
    }
    client.data.user = user;
    // Every user joins their personal room for position/state updates.
    await client.join(userRoom(user.id));
    await this.presence.markConnected(user.id);
  }

  async handleDisconnect(client: Socket): Promise<void> {
    const user = client.data.user as ActingUser | undefined;
    if (!user) {
      return;
    }
    await this.presence.markDisconnected(user.id);
    // Refresh presence for any consultation rooms this socket was a member of.
    const rooms = [...client.rooms].filter((r) => r.startsWith('consultation:'));
    await Promise.all(rooms.map((room) => this.emitPresence(room.slice('consultation:'.length))));
  }

  /** Clinicians subscribe to the live triage queue (matrix: VIEW_QUEUE). */
  @SubscribeMessage(WS_EVENTS.SUBSCRIBE_QUEUE)
  handleSubscribeQueue(client: Socket): SubscriptionAck {
    const user = client.data.user as ActingUser | undefined;
    if (!user) {
      return { ok: false, error: 'unauthorized' };
    }
    if (user.role !== Role.NURSE && user.role !== Role.DOCTOR) {
      return { ok: false, error: 'forbidden' };
    }
    void client.join(QUEUE_ROOM);
    return { ok: true };
  }

  /** Participants join a consultation room (matrix: VIEW_CONSULTATION). */
  @SubscribeMessage(WS_EVENTS.JOIN_CONSULTATION)
  async handleJoinConsultation(
    client: Socket,
    payload: { consultationId?: string },
  ): Promise<SubscriptionAck> {
    const user = client.data.user as ActingUser | undefined;
    if (!user) {
      return { ok: false, error: 'unauthorized' };
    }
    const id = payload?.consultationId;
    if (!id) {
      return { ok: false, error: 'bad_request' };
    }

    const consultation = await this.prisma.consultation.findUnique({
      where: { id },
      select: { patientId: true, claimedBy: true, state: true },
    });
    if (!consultation) {
      return { ok: false, error: 'not_found' };
    }

    try {
      authorizeConsultationAction(user, consultation, Action.VIEW_CONSULTATION);
    } catch {
      // Admin or any non-participant lands here — separation of duties over WS.
      return { ok: false, error: 'forbidden' };
    }

    await client.join(consultationRoom(id));
    await this.emitPresence(id);
    return { ok: true };
  }

  @SubscribeMessage(WS_EVENTS.LEAVE_CONSULTATION)
  async handleLeaveConsultation(
    client: Socket,
    payload: { consultationId?: string },
  ): Promise<SubscriptionAck> {
    const id = payload?.consultationId;
    if (!id) {
      return { ok: false, error: 'bad_request' };
    }
    await client.leave(consultationRoom(id));
    await this.emitPresence(id);
    return { ok: true };
  }

  private authenticate(client: Socket): ActingUser | null {
    const header = client.handshake.headers.authorization;
    const token =
      (client.handshake.auth?.token as string | undefined) ??
      (header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined);
    if (!token) {
      return null;
    }
    try {
      const payload = this.jwt.verify<JwtPayload>(token);
      return { id: payload.sub, role: payload.role as Role };
    } catch {
      return null;
    }
  }

  /** Emit the current online status of a consultation's participants to its room. */
  private async emitPresence(consultationId: string): Promise<void> {
    const consultation = await this.prisma.consultation.findUnique({
      where: { id: consultationId },
      select: { patientId: true, claimedBy: true },
    });
    if (!consultation) {
      return;
    }
    const ids = [consultation.patientId, consultation.claimedBy].filter(
      (v): v is string => typeof v === 'string',
    );
    const participants = await Promise.all(
      ids.map(async (userId) => ({ userId, online: await this.presence.isOnline(userId) })),
    );
    const payload: PresenceUpdatedPayload = { consultationId, participants };
    this.server.to(consultationRoom(consultationId)).emit(WS_EVENTS.PRESENCE_UPDATED, payload);
  }
}
