import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { MessagingController } from './messaging.controller';
import { MessagingService } from './messaging.service';

@Module({
  imports: [AuditModule],
  controllers: [MessagingController],
  providers: [MessagingService],
})
export class MessagingModule {}
