import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditEventType } from './audit-events';

export interface AuditEvent {
  actorId?: string | null;
  eventType: AuditEventType;
  consultationId?: string | null;
  /** Who/what/when context only — never clinical content. */
  metadata?: Prisma.InputJsonValue;
}

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Append an audit record. Accepts an optional transaction client so the audit
   * write commits atomically with the state change it describes.
   */
  async record(event: AuditEvent, tx?: Prisma.TransactionClient): Promise<void> {
    const client = tx ?? this.prisma;
    await client.auditLog.create({
      data: {
        actorId: event.actorId ?? null,
        eventType: event.eventType,
        consultationId: event.consultationId ?? null,
        metadata: event.metadata,
      },
    });
  }

  /** Admin-only read of the audit trail (most recent first). */
  async list(limit = 200): Promise<Array<Record<string, unknown>>> {
    const rows = await this.prisma.auditLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit, 500),
    });
    return rows.map((row) => ({
      id: row.id,
      actorId: row.actorId,
      eventType: row.eventType,
      consultationId: row.consultationId,
      metadata: row.metadata,
      createdAt: row.createdAt,
    }));
  }
}
