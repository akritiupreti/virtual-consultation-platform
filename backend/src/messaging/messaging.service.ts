import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ConsultationState } from '@prisma/client';
import { AUDIT_EVENTS } from '../audit/audit-events';
import { AuditService } from '../audit/audit.service';
import { Action } from '../common/authz/authorization-matrix';
import { ActingUser, authorizeConsultationAction } from '../common/authz/policy';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { SendMessageDto } from './dto/send-message.dto';

export interface MessageView {
  id: string;
  senderId: string;
  body: string;
  createdAt: Date;
}

@Injectable()
export class MessagingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly realtime: RealtimeService,
  ) {}

  /** Send a persisted message. Participants only, and only while IN_SESSION. */
  async send(user: ActingUser, consultationId: string, dto: SendMessageDto): Promise<MessageView> {
    const consultation = await this.loadOr404(consultationId);
    authorizeConsultationAction(user, consultation, Action.SEND_MESSAGE);

    if (consultation.state !== ConsultationState.IN_SESSION) {
      throw new ConflictException('Messaging is only allowed during an active session');
    }

    const message = await this.prisma.message.create({
      data: { consultationId, senderId: user.id, body: dto.body },
    });

    // Audit records that a message was sent — never its body (invariant 5 & 6).
    await this.audit.record({
      actorId: user.id,
      eventType: AUDIT_EVENTS.MESSAGE_SENT,
      consultationId,
      metadata: { senderRole: user.role },
    });

    // Push to the private consultation room. The room's members are exactly the
    // participants the matrix allows to read messages (admins can never join), so
    // emitting the body here stays within the authorization boundary (ADR-0009).
    this.realtime.broadcastMessage({
      consultationId,
      message: {
        id: message.id,
        senderId: message.senderId,
        body: message.body,
        createdAt: message.createdAt.toISOString(),
      },
    });

    return {
      id: message.id,
      senderId: message.senderId,
      body: message.body,
      createdAt: message.createdAt,
    };
  }

  /**
   * List messages for a consultation. Participants only — an admin is denied by
   * the authorization matrix (separation of duties, invariant 3; SC-6). Readable
   * in and after a session so both parties can review the exchange.
   */
  async list(user: ActingUser, consultationId: string): Promise<MessageView[]> {
    const consultation = await this.loadOr404(consultationId);
    authorizeConsultationAction(user, consultation, Action.READ_MESSAGES);

    const messages = await this.prisma.message.findMany({
      where: { consultationId },
      orderBy: { createdAt: 'asc' },
    });
    return messages.map((m) => ({
      id: m.id,
      senderId: m.senderId,
      body: m.body,
      createdAt: m.createdAt,
    }));
  }

  private async loadOr404(
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
}
