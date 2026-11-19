import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Role, UserStatus } from '@prisma/client';
import { UsersService } from '../src/users/users.service';

/**
 * Unit coverage for admin user management guards not fully exercised end-to-end
 * (FR-14, FR-23/24/25, ADR-0010): self-deactivation, double-deactivate/activate,
 * 404s, and the "not during an active session" rule.
 */
function makeDeps() {
  const prisma = {
    user: { findMany: jest.fn(), findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const realtime = { disconnectUser: jest.fn() };
  const service = new UsersService(prisma as never, audit as never, realtime as never);
  return { service, prisma, audit, realtime };
}

const admin = { id: 'admin', role: Role.ADMIN };
const userRow = (over: Partial<Record<string, unknown>> = {}) => ({
  id: 'u',
  email: 'u@vcp.test',
  role: Role.DOCTOR,
  status: UserStatus.ACTIVE,
  createdAt: new Date(),
  ...over,
});

describe('UsersService (unit)', () => {
  it('lists users without clinical content', async () => {
    const { service, prisma } = makeDeps();
    prisma.user.findMany.mockResolvedValue([userRow()]);
    const list = await service.list();
    expect(list).toHaveLength(1);
    expect(list[0]).not.toHaveProperty('passwordHash');
  });

  it('refuses self-deactivation', async () => {
    const { service } = makeDeps();
    await expect(service.deactivate(admin, 'admin')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('404s deactivating a missing user', async () => {
    const { service, prisma } = makeDeps();
    prisma.user.findUnique.mockResolvedValue(null);
    await expect(service.deactivate(admin, 'ghost')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses to deactivate an already-deactivated user', async () => {
    const { service, prisma } = makeDeps();
    prisma.user.findUnique.mockResolvedValue(userRow({ status: UserStatus.DEACTIVATED }));
    await expect(service.deactivate(admin, 'u')).rejects.toBeInstanceOf(ConflictException);
  });

  it('deactivates a user who is not in a session, audits it and drops sockets', async () => {
    const { service, prisma, audit, realtime } = makeDeps();
    prisma.user.findUnique.mockResolvedValue(userRow({ role: Role.DOCTOR }));
    prisma.user.updateMany.mockResolvedValue({ count: 1 });
    const result = await service.deactivate(admin, 'u');
    // The guard is part of the UPDATE itself: no IN_SESSION case on either side.
    expect(prisma.user.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'u',
          consultationsAsPatient: { none: { state: 'IN_SESSION' } },
          consultationsClaimed: { none: { state: 'IN_SESSION' } },
        }),
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'USER_DEACTIVATED' }),
    );
    expect(realtime.disconnectUser).toHaveBeenCalledWith('u');
    expect(result.status).toBe(UserStatus.DEACTIVATED);
  });

  it('refuses to deactivate a user who is in an active session (409)', async () => {
    const { service, prisma, audit, realtime } = makeDeps();
    prisma.user.findUnique.mockResolvedValue(userRow({ role: Role.NURSE }));
    prisma.user.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.deactivate(admin, 'u')).rejects.toBeInstanceOf(ConflictException);
    expect(audit.record).not.toHaveBeenCalled();
    expect(realtime.disconnectUser).not.toHaveBeenCalled();
  });

  it('refuses to reactivate an already-active user', async () => {
    const { service, prisma } = makeDeps();
    prisma.user.findUnique.mockResolvedValue(userRow({ status: UserStatus.ACTIVE }));
    await expect(service.reactivate(admin, 'u')).rejects.toBeInstanceOf(ConflictException);
  });

  it('reactivates a deactivated user', async () => {
    const { service, prisma, audit } = makeDeps();
    prisma.user.findUnique.mockResolvedValue(userRow({ status: UserStatus.DEACTIVATED }));
    prisma.user.update.mockResolvedValue(userRow({ status: UserStatus.ACTIVE }));
    const view = await service.reactivate(admin, 'u');
    expect(view.status).toBe(UserStatus.ACTIVE);
    expect(audit.record).toHaveBeenCalled();
  });

  it('404s reactivating a missing user', async () => {
    const { service, prisma } = makeDeps();
    prisma.user.findUnique.mockResolvedValue(null);
    await expect(service.reactivate(admin, 'ghost')).rejects.toBeInstanceOf(NotFoundException);
  });
});
