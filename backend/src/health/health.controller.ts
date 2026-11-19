import { Controller, Get } from '@nestjs/common';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';
import { PrismaHealthIndicator } from './prisma.health';

/**
 * Readiness probe (SC-15). Distinct from liveness (`GET /health` in AppController,
 * which only says the process is up): readiness answers "can this instance serve
 * traffic right now?" by checking its real dependency.
 *
 * - **PostgreSQL gates readiness** — unreachable DB ⇒ 503 (the node is pulled from
 *   rotation until it recovers).
 */
@Controller()
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly postgres: PrismaHealthIndicator,
  ) {}

  @Get('ready')
  @HealthCheck()
  ready() {
    return this.health.check([() => this.postgres.isHealthy('postgres')]);
  }
}
