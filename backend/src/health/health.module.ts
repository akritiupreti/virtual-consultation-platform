import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { RealtimeModule } from '../realtime/realtime.module';
import { HealthController } from './health.controller';
import { PrismaHealthIndicator } from './prisma.health';
import { RedisHealthIndicator } from './redis.health';

/**
 * Readiness probe wiring (Phase 5). Imports RealtimeModule only to reuse its
 * exported REDIS_CLIENT for the non-gating Redis check; PrismaService comes from
 * the global PrismaModule.
 */
@Module({
  imports: [TerminusModule, RealtimeModule],
  controllers: [HealthController],
  providers: [PrismaHealthIndicator, RedisHealthIndicator],
})
export class HealthModule {}
