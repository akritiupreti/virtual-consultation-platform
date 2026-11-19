import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CorrelationService } from '../common/correlation/correlation.service';
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
  constructor(
    private readonly prisma: PrismaService,
    private readonly correlation: CorrelationService,
  ) {}

  /**
   * Append an audit record. Accepts an optional transaction client so the audit
   * write commits atomically with the state change it describes. The active
   * request's correlation ID is stamped into the metadata (who/what/when/where —
   * a trace token, never clinical content) so an audited action can be tied back
   * to its request/WS-event/sweep log lines (SC-15). Stored in `metadata` to avoid
   * a schema migration; the admin query already returns metadata verbatim.
   */
  async record(event: AuditEvent, tx?: Prisma.TransactionClient): Promise<void> {
    const client = tx ?? this.prisma;
    await client.auditLog.create({
      data: {
        actorId: event.actorId ?? null,
        eventType: event.eventType,
        consultationId: event.consultationId ?? null,
        metadata: this.withCorrelation(event.metadata),
      },
    });
  }

  /** Merge the correlation ID into object metadata without clobbering an explicit
   * one; leaves non-object metadata untouched. */
  private withCorrelation(metadata?: Prisma.InputJsonValue): Prisma.InputJsonValue | undefined {
    const correlationId = this.correlation.getId();
    if (!correlationId) {
      return metadata;
    }
    if (metadata === null || metadata === undefined) {
      return { correlationId };
    }
    if (typeof metadata === 'object' && !Array.isArray(metadata)) {
      const obj = metadata as Record<string, unknown>;
      return 'correlationId' in obj
        ? metadata
        : ({ ...obj, correlationId } as Prisma.InputJsonValue);
    }
    return metadata;
  }

  /**
   * Admin-only, filterable, paginated read of the audit trail (FR-15, most recent
   * first). Filters compose (actor AND event type AND consultation AND time range).
   * The projection is who/what/when only — it never joins to or returns message
   * bodies or summary text (invariant 3; SC-6).
   */
  async query(filters: AuditQuery = {}): Promise<AuditPage> {
    const limit = clamp(filters.limit ?? 50, 1, 200);
    const offset = Math.max(0, filters.offset ?? 0);

    const where: Prisma.AuditLogWhereInput = {};
    if (filters.actorId) {
      where.actorId = filters.actorId;
    }
    if (filters.eventType) {
      where.eventType = filters.eventType;
    }
    if (filters.consultationId) {
      where.consultationId = filters.consultationId;
    }
    if (filters.from || filters.to) {
      where.createdAt = {
        ...(filters.from ? { gte: new Date(filters.from) } : {}),
        ...(filters.to ? { lte: new Date(filters.to) } : {}),
      };
    }

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.auditLog.count({ where }),
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: offset,
        take: limit,
        // Explicit projection: who / what / when only — no clinical content.
        select: {
          id: true,
          actorId: true,
          eventType: true,
          consultationId: true,
          metadata: true,
          createdAt: true,
        },
      }),
    ]);

    return { items: rows, total, limit, offset };
  }
}

export interface AuditQuery {
  actorId?: string;
  eventType?: string;
  consultationId?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export interface AuditPage {
  items: Array<Record<string, unknown>>;
  total: number;
  limit: number;
  offset: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
