import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { SummariesController } from './summaries.controller';
import { SummariesService } from './summaries.service';

@Module({
  imports: [AuditModule],
  controllers: [SummariesController],
  providers: [SummariesService],
})
export class SummariesModule {}
