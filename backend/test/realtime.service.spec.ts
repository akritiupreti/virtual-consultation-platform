import { ConsultationState } from '@prisma/client';
import { RealtimeService } from '../src/realtime/realtime.service';

/**
 * Unit coverage for the real-time publisher's no-socket and cache-degrade paths
 * (ADR-0004/0005): emits are safe no-ops with no server attached, and a Redis
 * failure degrades the position cache without throwing.
 */
function emitter() {
  return { emit: jest.fn() };
}
function fakeServer() {
  const to = jest.fn(() => emitter());
  const inRoom = jest.fn(() => ({ disconnectSockets: jest.fn() }));
  return { to, in: inRoom } as never;
}

describe('RealtimeService (unit)', () => {
  it('is a safe no-op when no socket server is attached', async () => {
    const prisma = { consultation: { findMany: jest.fn().mockResolvedValue([]) } };
    const service = new RealtimeService(prisma as never, null);
    expect(() =>
      service.broadcastConsultationUpdated({
        id: 'c-1',
        patientId: 'p',
        state: ConsultationState.ENDED,
      }),
    ).not.toThrow();
    service.broadcastMessage({ consultationId: 'c-1', message: {} as never });
    service.disconnectUser('u');
    await expect(service.getCachedPosition('c-1')).resolves.toBeNull();
  });

  it('emits to rooms once a server is set and recomputes positions', async () => {
    const prisma = {
      consultation: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'c-1', patientId: 'p1' },
          { id: 'c-2', patientId: 'p2' },
        ]),
      },
    };
    const redis = { set: jest.fn().mockResolvedValue('OK'), get: jest.fn() };
    const service = new RealtimeService(prisma as never, redis as never);
    const server = fakeServer();
    service.setServer(server);
    await service.notifyQueueChanged('claimed', 'c-1');
    expect(prisma.consultation.findMany).toHaveBeenCalled();
    expect(redis.set).toHaveBeenCalledTimes(2);
  });

  it('reads a cached position, and degrades to null on a Redis error', async () => {
    const prisma = { consultation: { findMany: jest.fn() } };
    const redis = {
      get: jest.fn().mockResolvedValueOnce('3').mockRejectedValueOnce(new Error('down')),
      set: jest.fn(),
    };
    const service = new RealtimeService(prisma as never, redis as never);
    await expect(service.getCachedPosition('c-1')).resolves.toBe(3);
    await expect(service.getCachedPosition('c-1')).resolves.toBeNull();
  });

  it('swallows a Redis write failure when caching positions', async () => {
    const prisma = {
      consultation: { findMany: jest.fn().mockResolvedValue([{ id: 'c-1', patientId: 'p1' }]) },
    };
    const redis = { set: jest.fn().mockRejectedValue(new Error('down')), get: jest.fn() };
    const service = new RealtimeService(prisma as never, redis as never);
    service.setServer(fakeServer());
    await expect(service.recomputeQueuePositions()).resolves.toBeUndefined();
  });
});
