import { Injectable } from '@nestjs/common';
import { HealthIndicator, HealthIndicatorResult, HealthCheckError } from '@nestjs/terminus';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Readiness indicator for PostgreSQL — the system of record (ADR-0002). A cheap
 * `SELECT 1` proves the connection pool can actually serve a query. This check
 * **gates** readiness: if the database is unreachable the instance is not ready to
 * take traffic, so `/ready` returns 503 (SC-15 dependency probe).
 */
@Injectable()
export class PrismaHealthIndicator extends HealthIndicator {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return this.getStatus(key, true);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unreachable';
      throw new HealthCheckError(
        'PostgreSQL check failed',
        this.getStatus(key, false, { message }),
      );
    }
  }
}
