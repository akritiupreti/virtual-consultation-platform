import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { randomUUID } from 'node:crypto';
import { AUDIT_EVENTS } from '../audit/audit-events';
import { AuditService } from '../audit/audit.service';
import { CorrelationService } from '../common/correlation/correlation.service';
import { REQUEUE, transitionFor } from '../common/state-machine/transitions';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from './realtime.service';

const SWEEP_INTERVAL_NAME = 'claim-ttl-sweep';
const DEFAULT_TTL_SECONDS = 120;
const DEFAULT_SWEEP_INTERVAL_SECONDS = 15;

// The auto-requeue's from/to states come from the central transition registry
// (invariant 1 — the state machine is the single source of truth, not re-encoded
// here). REQUEUE is defined as CLAIMED → QUEUED in docs/state-machine.md.
const REQUEUE_TRANSITION = transitionFor(REQUEUE)!;

/**
 * Claim-start TTL (FR-12 / SC-4, ADR-0008). A case that is CLAIMED but not
 * started within the TTL is auto-requeued: a DB-authoritative sweeper finds
 * overdue claims and requeues each with the same atomic conditional UPDATE the
 * claim uses, so a race with a legitimate start resolves in the database and
 * never double-fires. Every requeue is audited (CONSULTATION_REQUEUED) and the
 * queue subscribers + the patient are notified.
 */
@Injectable()
export class ClaimTtlService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(ClaimTtlService.name);
  private readonly ttlSeconds: number;
  private readonly sweepIntervalSeconds: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly realtime: RealtimeService,
    private readonly scheduler: SchedulerRegistry,
    private readonly correlation: CorrelationService,
    config: ConfigService,
  ) {
    this.ttlSeconds = positiveIntOr(config.get('CLAIM_START_TTL_SECONDS'), DEFAULT_TTL_SECONDS);
    this.sweepIntervalSeconds = positiveIntOr(
      config.get('CLAIM_TTL_SWEEP_INTERVAL_SECONDS'),
      DEFAULT_SWEEP_INTERVAL_SECONDS,
    );
  }

  onModuleInit(): void {
    const handle = setInterval(() => {
      void this.sweepExpiredClaims();
    }, this.sweepIntervalSeconds * 1000);
    this.scheduler.addInterval(SWEEP_INTERVAL_NAME, handle);
    this.log.log(
      `Claim-start TTL sweeper active: TTL ${this.ttlSeconds}s, every ${this.sweepIntervalSeconds}s.`,
    );
  }

  onModuleDestroy(): void {
    if (this.scheduler.doesExist('interval', SWEEP_INTERVAL_NAME)) {
      this.scheduler.deleteInterval(SWEEP_INTERVAL_NAME);
    }
  }

  /**
   * Requeue every CLAIMED-but-not-started case whose claim is older than the TTL.
   * Returns the number actually requeued (exposed so tests can drive it
   * deterministically). Safe to run concurrently across instances: the atomic
   * UPDATE guarantees exactly one requeue per case.
   */
  async sweepExpiredClaims(): Promise<number> {
    // Each sweep runs under its own correlation ID so the requeue audit rows and
    // log lines it produces share one trace token (SC-15), even though no HTTP
    // request drives it.
    return this.correlation.run(randomUUID(), () => this.doSweep());
  }

  private async doSweep(): Promise<number> {
    const cutoff = new Date(Date.now() - this.ttlSeconds * 1000);
    const overdue = await this.prisma.consultation.findMany({
      where: {
        state: { in: REQUEUE_TRANSITION.from },
        startedAt: null,
        claimedAt: { lt: cutoff },
      },
      select: { id: true, patientId: true, claimedBy: true },
    });

    let requeued = 0;
    for (const consultation of overdue) {
      const result = await this.prisma.consultation.updateMany({
        where: {
          id: consultation.id,
          state: { in: REQUEUE_TRANSITION.from },
          startedAt: null,
        },
        data: {
          state: REQUEUE_TRANSITION.to,
          claimedBy: null,
          claimedAt: null,
          version: { increment: 1 },
        },
      });
      if (result.count !== 1) {
        // The clinician started it (or another sweeper won) between read and write.
        continue;
      }
      requeued += 1;

      await this.audit.record({
        actorId: null,
        eventType: AUDIT_EVENTS.CONSULTATION_REQUEUED,
        consultationId: consultation.id,
        metadata: {
          reason: 'start_ttl_expired',
          ttlSeconds: this.ttlSeconds,
          previousClaimedBy: consultation.claimedBy,
        },
      });
      this.realtime.broadcastConsultationUpdated({
        id: consultation.id,
        patientId: consultation.patientId,
        state: REQUEUE_TRANSITION.to,
        // The clinician who let the claim lapse sees it leave their list live.
        claimedBy: consultation.claimedBy,
      });
    }

    if (requeued > 0) {
      this.log.log(`Auto-requeued ${requeued} claim(s) past the start TTL.`);
      await this.realtime.notifyQueueChanged('requeued');
    }
    return requeued;
  }
}

function positiveIntOr(raw: unknown, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
