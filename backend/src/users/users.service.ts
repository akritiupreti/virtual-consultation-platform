import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConsultationState, Role, UserStatus } from '@prisma/client';
import { AUDIT_EVENTS } from '../audit/audit-events';
import { AuditService } from '../audit/audit.service';
import { ActingUser } from '../common/authz/policy';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';

export interface UserView {
  id: string;
  email: string;
  role: Role;
  status: UserStatus;
  createdAt: Date;
}

/**
 * Admin-only user management (FR-14, FR-23/24/25). Deactivation is a soft state
 * change (never a delete) so history and audit references survive. Admins manage
 * accounts but never read clinical content (invariant 3) — nothing here returns
 * messages or summaries.
 */
@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly realtime: RealtimeService,
  ) {}

  /** List all accounts (no clinical content). */
  async list(): Promise<UserView[]> {
    const users = await this.prisma.user.findMany({ orderBy: { createdAt: 'asc' } });
    return users.map(toView);
  }

  /**
   * Deactivate an account. A deactivated user cannot log in (auth.service) and any
   * already-issued token is rejected (jwt strategy + WS handshake re-check status),
   * and their live sockets are dropped.
   *
   * A user who is in an active session (IN_SESSION, as the patient or the
   * assigned clinician) cannot be deactivated — the admin retries once the session
   * ends (FR-24, ADR-0010). A clinician who has only claimed a case can be: the
   * claim-start TTL returns that case to the queue (ADR-0008).
   */
  async deactivate(actor: ActingUser, targetId: string): Promise<UserView> {
    if (actor.id === targetId) {
      // Guard against an admin locking themselves out.
      throw new BadRequestException('You cannot deactivate your own account');
    }
    const target = await this.loadOr404(targetId);
    if (target.status === UserStatus.DEACTIVATED) {
      throw new ConflictException('User is already deactivated');
    }

    // One conditional UPDATE: it only succeeds if the user is not in an active
    // session at that moment, so the check and the write cannot be split by a
    // session starting in between.
    const notInSession = { none: { state: ConsultationState.IN_SESSION } };
    const result = await this.prisma.user.updateMany({
      where: {
        id: targetId,
        status: UserStatus.ACTIVE,
        consultationsAsPatient: notInSession,
        consultationsClaimed: notInSession,
      },
      data: { status: UserStatus.DEACTIVATED },
    });
    if (result.count !== 1) {
      throw new ConflictException(
        'This user is in an active consultation session; try again after it ends',
      );
    }

    await this.audit.record({
      actorId: actor.id,
      eventType: AUDIT_EVENTS.USER_DEACTIVATED,
      metadata: { targetUserId: targetId, targetRole: target.role },
    });

    this.realtime.disconnectUser(targetId);

    return { ...target, status: UserStatus.DEACTIVATED };
  }

  /** Reactivate a previously deactivated account; restores permitted access (FR-25). */
  async reactivate(actor: ActingUser, targetId: string): Promise<UserView> {
    const target = await this.loadOr404(targetId);
    if (target.status === UserStatus.ACTIVE) {
      throw new ConflictException('User is already active');
    }

    const updated = await this.prisma.user.update({
      where: { id: targetId },
      data: { status: UserStatus.ACTIVE },
    });

    await this.audit.record({
      actorId: actor.id,
      eventType: AUDIT_EVENTS.USER_REACTIVATED,
      metadata: { targetUserId: targetId, targetRole: target.role },
    });

    return toView(updated);
  }

  private async loadOr404(id: string): Promise<UserView> {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) {
      throw new NotFoundException('User not found');
    }
    return toView(user);
  }
}

function toView(user: {
  id: string;
  email: string;
  role: Role;
  status: UserStatus;
  createdAt: Date;
}): UserView {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    status: user.status,
    createdAt: user.createdAt,
  };
}
