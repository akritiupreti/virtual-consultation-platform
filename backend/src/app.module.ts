import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { AppController } from './app.controller';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { ConsultationsModule } from './consultations/consultations.module';
import { MessagingModule } from './messaging/messaging.module';
import { PrismaModule } from './prisma/prisma.module';
import { RealtimeModule } from './realtime/realtime.module';
import { SummariesModule } from './summaries/summaries.module';

@Module({
  imports: [
    // Single source of env: the monorepo-root .env (falls back to a local one).
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['../.env', '.env'] }),
    // Drives the claim-start TTL sweeper (ADR-0010).
    ScheduleModule.forRoot(),
    PrismaModule,
    AuthModule,
    AuditModule,
    RealtimeModule,
    ConsultationsModule,
    MessagingModule,
    SummariesModule,
  ],
  controllers: [AppController],
})
export class AppModule {}
