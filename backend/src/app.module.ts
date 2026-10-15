import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AppController } from './app.controller';
import { AttachmentsModule } from './attachments/attachments.module';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { buildThrottlerOptions } from './common/throttler/throttler.config';
import { ConsultationsModule } from './consultations/consultations.module';
import { MessagingModule } from './messaging/messaging.module';
import { PrismaModule } from './prisma/prisma.module';
import { RealtimeModule } from './realtime/realtime.module';
import { SummariesModule } from './summaries/summaries.module';
import { UsersModule } from './users/users.module';

@Module({
  imports: [
    // Single source of env: the monorepo-root .env (falls back to a local one).
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['../.env', '.env'] }),
    // Drives the claim-start TTL sweeper (ADR-0010).
    ScheduleModule.forRoot(),
    // App-level rate limiting (ADR-0011); stricter limits on auth + uploads.
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
    AttachmentsModule,
    UsersModule,
  ],
  controllers: [AppController],
  providers: [
    // Throttling applies globally; per-route overrides use @Throttle.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
