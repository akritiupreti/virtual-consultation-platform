import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { MessagingController } from './messaging.controller';
import { MessagingService } from './messaging.service';

@Module({
  imports: [AuditModule, RealtimeModule],
  controllers: [MessagingController],
  providers: [MessagingService],
})
export class MessagingModule {}
