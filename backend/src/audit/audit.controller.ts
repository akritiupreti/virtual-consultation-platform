import { Controller, DefaultValuePipe, Get, ParseIntPipe, Query, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../common/authz/roles.decorator';
import { RolesGuard } from '../common/authz/roles.guard';
import { AuditService } from './audit.service';

/**
 * Audit log is admin-only (FR-15). It deliberately exposes no clinical content —
 * separation of duties (invariant 3): admins operate the system but cannot read
 * messages, attachments, or summaries.
 */
@Controller('audit')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  list(
    @Query('limit', new DefaultValuePipe(200), ParseIntPipe) limit: number,
  ): Promise<Array<Record<string, unknown>>> {
    return this.audit.list(limit);
  }
}
