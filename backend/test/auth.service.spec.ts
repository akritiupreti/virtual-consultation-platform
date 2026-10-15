import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { AuthService } from '../src/auth/auth.service';

/**
 * Unit tests for AuthService with PrismaService + JwtService mocked.
 * (Integration tests against a real DB arrive in Phase 2.)
 */
describe('AuthService', () => {
  const jwt = { sign: jest.fn().mockReturnValue('signed.jwt.token') };
  // Login/registration emit security-relevant audit events; the mock just records calls.
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  let prisma: {
    user: { findUnique: jest.Mock; create: jest.Mock };
  };
  let service: AuthService;

  beforeEach(() => {
    prisma = {
      user: {
        findUnique: jest.fn(),
        create: jest.fn(),
      },
    };
    jwt.sign.mockClear();
    audit.record.mockClear();
    service = new AuthService(prisma as any, jwt as any, audit as any);
  });

  it('registers a new patient and returns an access token', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.user.create.mockResolvedValue({ id: 'u1', email: 'p@example.com', role: 'PATIENT' });

    const result = await service.register({ email: 'p@example.com', password: 'password123' });

    expect(prisma.user.create).toHaveBeenCalledTimes(1);
    // Public registration must always create a PATIENT (no privilege escalation).
    expect(prisma.user.create.mock.calls[0][0].data.role).toBe('PATIENT');
    expect(result.accessToken).toBe('signed.jwt.token');
    expect(result.user).toEqual({ id: 'u1', email: 'p@example.com', role: 'PATIENT' });
  });

  it('rejects a duplicate email on register', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'u1' });

    await expect(
      service.register({ email: 'p@example.com', password: 'password123' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it('rejects login with an unknown email', async () => {
    prisma.user.findUnique.mockResolvedValue(null);

    await expect(
      service.login({ email: 'ghost@example.com', password: 'whatever12' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects login for a deactivated user', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'u1',
      email: 'x@example.com',
      role: 'DOCTOR',
      status: 'DEACTIVATED',
      passwordHash: 'irrelevant',
    });

    await expect(
      service.login({ email: 'x@example.com', password: 'whatever12' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    // The failed attempt is audited with a reason code only — never the password.
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'LOGIN_FAILURE', metadata: { reason: 'deactivated' } }),
    );
  });

  it('audits a successful login', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'u1',
      email: 'doc@example.com',
      role: 'DOCTOR',
      status: 'ACTIVE',
      // bcrypt hash of 'password123' is irrelevant here — bcrypt.compare is real, so
      // use a value it will reject? No: we need a real match. Stub compare instead.
      passwordHash: await (await import('bcryptjs')).hash('password123', 4),
    });

    const result = await service.login({ email: 'doc@example.com', password: 'password123' });

    expect(result.accessToken).toBe('signed.jwt.token');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: 'u1', eventType: 'LOGIN_SUCCESS' }),
    );
  });
});
