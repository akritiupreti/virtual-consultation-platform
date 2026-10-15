import { Controller, HttpCode, Param, ParseUUIDPipe, Post, Get, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthenticatedUser } from '../auth/jwt.strategy';
import { ActingUser } from '../common/authz/policy';
import { Roles } from '../common/authz/roles.decorator';
import { RolesGuard } from '../common/authz/roles.guard';
import { DeactivationResult, UserView, UsersService } from './users.service';

function acting(user: AuthenticatedUser): ActingUser {
  return { id: user.id, role: user.role as Role };
}

/**
 * User management is admin-only (matrix: MANAGE_USERS). The role gate here is the
 * enforcement point; nothing on this controller exposes clinical content.
 */
@Controller('users')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  list(): Promise<UserView[]> {
    return this.users.list();
  }

  @Post(':id/deactivate')
  @HttpCode(200)
  deactivate(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<DeactivationResult> {
    return this.users.deactivate(acting(user), id);
  }

  @Post(':id/reactivate')
  @HttpCode(200)
  reactivate(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<UserView> {
    return this.users.reactivate(acting(user), id);
  }
}
