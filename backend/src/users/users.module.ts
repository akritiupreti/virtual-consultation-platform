import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { ConsultationsModule } from '../consultations/consultations.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

/**
 * UsersModule owns admin user management and the account-deactivation lifecycle
 * (FR-14, FR-23/24/25). It reuses ConsultationsService to reassign a deactivated
 * clinician's active cases and RealtimeService to drop their live sockets.
 */
@Module({
  imports: [AuditModule, ConsultationsModule, RealtimeModule],
  controllers: [UsersController],
  providers: [UsersService],
})
export class UsersModule {}
