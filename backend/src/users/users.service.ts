import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Role, UserStatus } from '@prisma/client';
import { AUDIT_EVENTS } from '../audit/audit-events';
import { AuditService } from '../audit/audit.service';
import { ActingUser } from '../common/authz/policy';
import { ConsultationsService } from '../consultations/consultations.service';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';

export interface UserView {
  id: string;
  email: string;
  role: Role;
  status: UserStatus;
  createdAt: Date;
}

export interface DeactivationResult extends UserView {
  /** Consultations reassigned to the queue because this clinician was mid-session. */
  reassignedConsultationIds: string[];
}

/**
 * Admin-only user management (FR-14, FR-23/24/25). Deactivation is a soft state
 * change (never a delete) so history and audit references survive. Admins manage
 * accounts but never read clinical content (invariant 3) — nothing here returns
 * messages, attachments, or summaries.
 */
@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly consultations: ConsultationsService,
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
   * and their live sockets are dropped. If the user is a clinician holding active
   * cases (CLAIMED/IN_SESSION), each case is paused and reassigned to the queue so
   * the patient is picked up by someone else and notified live (FR-24, ADR-0012).
   */
  async deactivate(actor: ActingUser, targetId: string): Promise<DeactivationResult> {
    if (actor.id === targetId) {
      // Guard against an admin locking themselves out.
      throw new BadRequestException('You cannot deactivate your own account');
    }
    const target = await this.loadOr404(targetId);
    if (target.status === UserStatus.DEACTIVATED) {
      throw new ConflictException('User is already deactivated');
    }

    const updated = await this.prisma.user.update({
      where: { id: targetId },
      data: { status: UserStatus.DEACTIVATED },
    });

    await this.audit.record({
      actorId: actor.id,
      eventType: AUDIT_EVENTS.USER_DEACTIVATED,
      metadata: { targetUserId: targetId, targetRole: target.role },
    });

    // Reassign active cases first, then drop the user's live sockets.
    let reassignedConsultationIds: string[] = [];
    if (target.role === Role.NURSE || target.role === Role.DOCTOR) {
      reassignedConsultationIds = await this.consultations.reassignActiveCasesOf(
        targetId,
        'clinician_deactivated',
      );
    }
    this.realtime.disconnectUser(targetId);

    return { ...toView(updated), reassignedConsultationIds };
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
