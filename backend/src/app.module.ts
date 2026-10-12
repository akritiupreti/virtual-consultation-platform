import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { ConsultationsModule } from './consultations/consultations.module';
import { MessagingModule } from './messaging/messaging.module';
import { PrismaModule } from './prisma/prisma.module';
import { SummariesModule } from './summaries/summaries.module';

@Module({
  imports: [
    // Single source of env: the monorepo-root .env (falls back to a local one).
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['../.env', '.env'] }),
    PrismaModule,
    AuthModule,
    AuditModule,
    ConsultationsModule,
    MessagingModule,
    SummariesModule,
  ],
  controllers: [AppController],
})
export class AppModule {}
