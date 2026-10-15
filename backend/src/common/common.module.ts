import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { CorrelationService } from './correlation/correlation.service';
import { MetricsController } from './metrics/metrics.controller';
import { MetricsInterceptor } from './metrics/metrics.interceptor';
import { MetricsService } from './metrics/metrics.service';

/**
 * Cross-cutting observability wiring (Phase 5, architecture.md §2): the
 * correlation-ID store (shared with REST middleware, the WS gateway, the sweeper
 * and the audit layer), the Prometheus metrics registry + scrape endpoint, and
 * the global request-timing interceptor. Global so `CorrelationService` and
 * `MetricsService` inject anywhere without re-importing. Structured logging itself
 * is configured by `LoggerModule` (nestjs-pino) in `AppModule`.
 */
@Global()
@Module({
  controllers: [MetricsController],
  providers: [
    CorrelationService,
    MetricsService,
    { provide: APP_INTERCEPTOR, useClass: MetricsInterceptor },
  ],
  exports: [CorrelationService, MetricsService],
})
export class CommonModule {}
