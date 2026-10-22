import { Controller, Get } from '@nestjs/common';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';
import { PrismaHealthIndicator } from './prisma.health';
import { RedisHealthIndicator } from './redis.health';

/**
 * Readiness probe (ADR-0004 / SC-15). Distinct from liveness (`GET /health` in
 * AppController, which only says the process is up): readiness answers "can this
 * instance serve traffic right now?" by checking its real dependencies.
 *
 * - **PostgreSQL gates readiness** — unreachable DB ⇒ 503 (the node is pulled from
 *   rotation until it recovers).
 * - **Redis is reported but never gates** — a cache outage degrades real-time only;
 *   core flows keep working, so it must not make the node unready (ADR-0004).
 */
@Controller()
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly postgres: PrismaHealthIndicator,
    private readonly redis: RedisHealthIndicator,
  ) {}

  @Get('ready')
  @HealthCheck()
  ready() {
    return this.health.check([
      () => this.postgres.isHealthy('postgres'),
      () => this.redis.check('redis'),
    ]);
  }
}
