import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { AppController } from './app.controller';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { CommonModule } from './common/common.module';
import { buildLoggerParams } from './common/logging/logging.config';
import { buildThrottlerOptions } from './common/throttler/throttler.config';
import { ConsultationsModule } from './consultations/consultations.module';
import { HealthModule } from './health/health.module';
import { MessagingModule } from './messaging/messaging.module';
import { PrismaModule } from './prisma/prisma.module';
import { RealtimeModule } from './realtime/realtime.module';
import { SummariesModule } from './summaries/summaries.module';
import { UsersModule } from './users/users.module';

@Module({
  imports: [
    // Single source of env: the monorepo-root .env (falls back to a local one).
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['../.env', '.env'] }),
    // Structured JSON logging with per-request correlation IDs (ADR-0011). Replaces
    // the default Nest logger; see buildLoggerParams for the no-PII/clinical policy.
    LoggerModule.forRoot(buildLoggerParams()),
    // Correlation store + Prometheus metrics + request-timing interceptor (Phase 5).
    CommonModule,
    // Drives the claim-start TTL sweeper (ADR-0008).
    ScheduleModule.forRoot(),
    // App-level rate limiting (ADR-0009); a stricter limit on auth.
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: buildThrottlerOptions,
    }),
    PrismaModule,
    AuthModule,
    AuditModule,
    RealtimeModule,
    ConsultationsModule,
    MessagingModule,
    SummariesModule,
    UsersModule,
    // Liveness (/health) and readiness (/ready, gated on PostgreSQL) probes.
    HealthModule,
  ],
  controllers: [AppController],
  providers: [
    // Throttling applies globally; per-route overrides use @Throttle.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
