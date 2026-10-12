import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';
import { ForbiddenActionException } from '../errors/domain-exceptions';
import { ROLES_KEY } from './roles.decorator';

/**
 * Enforces the `@Roles(...)` metadata on a route. Runs after JwtAuthGuard, so
 * `request.user` is populated. Deny-by-default: a route with `@Roles()` and a
 * user whose role is not listed is rejected with 403.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!required || required.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<{ user?: { role?: string } }>();
    const role = request.user?.role as Role | undefined;

    if (!role || !required.includes(role)) {
      throw new ForbiddenActionException('Your role may not perform this action');
    }
    return true;
  }
}
