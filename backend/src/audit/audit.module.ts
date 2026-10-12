import { Module } from '@nestjs/common';
import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';

/**
 * AuditModule owns the append-only audit trail. AuditService is exported so the
 * consultation / messaging / summary modules can record events; the read side is
 * admin-only (AuditController).
 */
@Module({
  controllers: [AuditController],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
