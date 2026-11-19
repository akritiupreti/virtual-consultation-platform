import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

/**
 * UsersModule owns admin user management and the account-deactivation lifecycle
 * (FR-14, FR-23/24/25). It uses RealtimeService to drop a deactivated user's live
 * sockets.
 */
@Module({
  imports: [AuditModule, RealtimeModule],
  controllers: [UsersController],
  providers: [UsersService],
})
export class UsersModule {}
