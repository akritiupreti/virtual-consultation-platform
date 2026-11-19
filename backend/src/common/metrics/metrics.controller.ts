import { Controller, Get, Header } from '@nestjs/common';
import { register as defaultRegister } from 'prom-client';
import { MetricsService } from './metrics.service';

/**
 * Prometheus scrape endpoint (ADR-0012). Unauthenticated by design — it exposes
 * only aggregate counts, no PII or clinical content — and
 * is reachable on the local Compose network for a scraper. The content type is the
 * Prometheus text exposition format.
 */
@Controller('metrics')
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get()
  @Header('Content-Type', defaultRegister.contentType)
  async scrape(): Promise<string> {
    return this.metrics.render();
  }
}
