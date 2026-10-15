import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { AuditModule } from '../audit/audit.module';
import { ClaimTtlService } from './claim-ttl.service';
import { PresenceService } from './presence.service';
import { RealtimeGateway } from './realtime.gateway';
import { RealtimeService } from './realtime.service';
import { REDIS_CLIENT, redisClientProvider } from './redis.provider';

/**
 * Real-time module (Phase 3): the WebSocket gateway, the fan-out publisher, Redis
 * presence + position cache, and the claim-start TTL sweeper. RealtimeService is
 * exported so the consultation / messaging / summary services can emit events
 * after they commit to PostgreSQL. This module imports AuditModule (for the
 * requeue audit) but is imported by those feature modules, so there is no cycle.
 */
@Module({
  imports: [
    AuditModule,
    // Same JWT verification as the REST guards, for the socket handshake.
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_SECRET'),
        signOptions: { expiresIn: config.get<string>('JWT_EXPIRES_IN') ?? '15m' },
      }),
    }),
  ],
  providers: [
    redisClientProvider,
    PresenceService,
    RealtimeService,
    RealtimeGateway,
    ClaimTtlService,
  ],
  // RealtimeService for event emission; REDIS_CLIENT so the readiness probe can
  // reuse the single shared connection (ADR-0004) rather than opening its own.
  exports: [RealtimeService, REDIS_CLIENT],
})
export class RealtimeModule {}
