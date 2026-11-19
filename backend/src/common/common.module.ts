import { Global, Module } from '@nestjs/common';
import { CorrelationService } from './correlation/correlation.service';
import { MetricsController } from './metrics/metrics.controller';
import { MetricsService } from './metrics/metrics.service';

/**
 * Cross-cutting observability wiring (Phase 5, architecture.md §2): the
 * correlation-ID store (shared with REST middleware, the WS gateway, the sweeper
 * and the audit layer) and the Prometheus metrics registry + scrape endpoint.
 * Global so `CorrelationService` and
 * `MetricsService` inject anywhere without re-importing. Structured logging itself
 * is configured by `LoggerModule` (nestjs-pino) in `AppModule`.
 */
@Global()
@Module({
  controllers: [MetricsController],
  providers: [CorrelationService, MetricsService],
  exports: [CorrelationService, MetricsService],
})
export class CommonModule {}
