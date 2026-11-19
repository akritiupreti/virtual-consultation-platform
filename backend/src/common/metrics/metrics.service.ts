import { Injectable } from '@nestjs/common';
import { ConsultationState } from '@prisma/client';
import { collectDefaultMetrics, Gauge, Registry } from 'prom-client';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Owns the Prometheus registry and the platform's metrics (ADR-0012):
 *
 * - **Default process metrics** — memory, CPU, event-loop lag (prom-client).
 * - **Domain metrics** — `vcp_queue_depth` (QUEUED consultations) and
 *   `vcp_active_consultations` (IN_SESSION), read from PostgreSQL — the system of
 *   record (ADR-0002) — on each scrape via an async `collect` callback, so the
 *   numbers are always the authoritative counts and need no event bookkeeping.
 *
 * Every series is an aggregate count — never PII or clinical content (NFR-2).
 */
@Injectable()
export class MetricsService {
  readonly registry = new Registry();

  constructor(private readonly prisma: PrismaService) {
    this.registry.setDefaultLabels({ app: 'vcp-backend' });
    collectDefaultMetrics({ register: this.registry });

    // `collect` runs on each scrape with the Gauge as `this`; the arrow closure
    // captures the service so it can query PostgreSQL for the authoritative count.
    const countByState = (state: ConsultationState): Promise<number> => this.countByState(state);

    new Gauge({
      name: 'vcp_queue_depth',
      help: 'Consultations currently in the triage queue (QUEUED)',
      registers: [this.registry],
      async collect(this: Gauge): Promise<void> {
        this.set(await countByState(ConsultationState.QUEUED));
      },
    });

    new Gauge({
      name: 'vcp_active_consultations',
      help: 'Consultations currently in session (IN_SESSION)',
      registers: [this.registry],
      async collect(this: Gauge): Promise<void> {
        this.set(await countByState(ConsultationState.IN_SESSION));
      },
    });
  }

  /** The full Prometheus exposition text (awaits the async domain collectors). */
  async render(): Promise<string> {
    return this.registry.metrics();
  }

  private async countByState(state: ConsultationState): Promise<number> {
    try {
      return await this.prisma.consultation.count({ where: { state } });
    } catch {
      // A metrics scrape must never throw into the request path; report 0 on a
      // transient DB hiccup rather than failing the endpoint.
      return 0;
    }
  }
}
