import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { ConsultationsController } from './consultations.controller';
import { ConsultationsService } from './consultations.service';

/**
 * ConsultationsModule owns the state machine, DB-atomic claim, and lifecycle
 * transitions. It exports its service so feature modules (messaging, summaries)
 * can reuse consultation lookups where needed.
 */
@Module({
  imports: [AuditModule],
  controllers: [ConsultationsController],
  providers: [ConsultationsService],
  exports: [ConsultationsService],
})
export class ConsultationsModule {}
