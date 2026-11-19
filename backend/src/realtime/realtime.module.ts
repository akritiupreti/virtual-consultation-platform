import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { AuditModule } from '../audit/audit.module';
import { ClaimTtlService } from './claim-ttl.service';
import { RealtimeGateway } from './realtime.gateway';
import { RealtimeService } from './realtime.service';

/**
 * Real-time module (Phase 3): the WebSocket gateway, the fan-out publisher, and
 * the claim-start TTL sweeper. RealtimeService is
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
  providers: [RealtimeService, RealtimeGateway, ClaimTtlService],
  // RealtimeService for event emission by the feature modules.
  exports: [RealtimeService],
})
export class RealtimeModule {}
