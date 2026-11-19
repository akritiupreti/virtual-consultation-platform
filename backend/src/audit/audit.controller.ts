import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../common/authz/roles.decorator';
import { RolesGuard } from '../common/authz/roles.guard';
import { AuditPage, AuditService } from './audit.service';
import { AuditQueryDto } from './dto/audit-query.dto';

/**
 * Audit log is admin-only (FR-15). It deliberately exposes no clinical content —
 * separation of duties (invariant 3): admins operate the system but cannot read
 * messages or summaries. Supports filtering by actor, event type,
 * consultation, and time range, with pagination.
 */
@Controller('audit')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  list(@Query() query: AuditQueryDto): Promise<AuditPage> {
    return this.audit.query(query);
  }
}
