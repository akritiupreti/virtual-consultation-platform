import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Role, UserStatus } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { AUDIT_EVENTS } from '../audit/audit-events';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';

const SALT_ROUNDS = 10;

export interface AuthResult {
  accessToken: string;
  user: { id: string; email: string; role: Role };
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly audit: AuditService,
  ) {}

  async register(dto: RegisterDto): Promise<AuthResult> {
    const existing = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (existing) {
      throw new ConflictException('Email already registered');
    }

    const passwordHash = await bcrypt.hash(dto.password, SALT_ROUNDS);
    const user = await this.prisma.user.create({
      data: { email: dto.email, passwordHash, role: Role.PATIENT },
    });

    return this.sign(user.id, user.email, user.role);
  }

  async login(dto: LoginDto): Promise<AuthResult> {
    const user = await this.prisma.user.findUnique({ where: { email: dto.email } });
    // Uniform error avoids leaking which part failed; deactivated users cannot log in (FR-25).
    if (!user || user.status === UserStatus.DEACTIVATED) {
      // Audit the failure (security-relevant). Record a reason code only — never the
      // attempted email or password. actorId is the user id when known, else null.
      await this.recordLoginFailure(user?.id ?? null, user ? 'deactivated' : 'unknown_user');
      throw new UnauthorizedException('Invalid credentials');
    }

    const passwordOk = await bcrypt.compare(dto.password, user.passwordHash);
    if (!passwordOk) {
      await this.recordLoginFailure(user.id, 'bad_password');
      throw new UnauthorizedException('Invalid credentials');
    }

    await this.audit.record({
      actorId: user.id,
      eventType: AUDIT_EVENTS.LOGIN_SUCCESS,
      metadata: { role: user.role },
    });
    return this.sign(user.id, user.email, user.role);
  }

  private async recordLoginFailure(actorId: string | null, reason: string): Promise<void> {
    await this.audit.record({
      actorId,
      eventType: AUDIT_EVENTS.LOGIN_FAILURE,
      metadata: { reason },
    });
  }

  private sign(id: string, email: string, role: Role): AuthResult {
    const accessToken = this.jwt.sign({ sub: id, email, role });
    return { accessToken, user: { id, email, role } };
  }
}
