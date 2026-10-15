import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { SummariesController } from './summaries.controller';
import { SummariesService } from './summaries.service';

@Module({
  imports: [AuditModule, RealtimeModule],
  controllers: [SummariesController],
  providers: [SummariesService],
})
export class SummariesModule {}
