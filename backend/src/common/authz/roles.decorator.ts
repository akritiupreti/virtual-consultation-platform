import { SetMetadata } from '@nestjs/common';
import { Role } from '@prisma/client';

export const ROLES_KEY = 'roles';

/**
 * Coarse controller-level role gate. The authoritative role + state + ownership
 * check runs in the service via {@link authorizeConsultationAction}; this fails
 * fast and keeps the allowed roles visible on the route (defense in depth).
 */
export const Roles = (...roles: Role[]): MethodDecorator & ClassDecorator =>
  SetMetadata(ROLES_KEY, roles);
