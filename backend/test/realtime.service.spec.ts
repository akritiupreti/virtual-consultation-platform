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

  it('fans consultation state out to the room, the patient and the assigned clinician once', () => {
    const service = new RealtimeService({} as never, null);
    const room = emitter();
    const server = { to: jest.fn(() => room) };
    service.setServer(server as never);
    service.broadcastConsultationUpdated({
      id: 'c-1',
      patientId: 'p',
      state: ConsultationState.ENDED,
      claimedBy: 'n',
    });
    // One multi-room emit: a socket in several of these rooms is notified once.
    expect(server.to).toHaveBeenCalledTimes(1);
    expect(server.to).toHaveBeenCalledWith(['consultation:c-1', 'user:p', 'user:n']);
    expect(room.emit).toHaveBeenCalledWith('consultation:updated', {
      consultationId: 'c-1',
      state: ConsultationState.ENDED,
    });
  });

  it('sends summary signals to the sign-off room and the assignee, never the patient', () => {
    const service = new RealtimeService({} as never, null);
    const room = emitter();
    const server = { to: jest.fn(() => room) };
    service.setServer(server as never);
    service.notifySummaryUpdated({ consultationId: 'c-1', claimedBy: 'n', reason: 'drafted' });
    expect(server.to).toHaveBeenCalledWith(['signoff', 'user:n']);
    expect(room.emit).toHaveBeenCalledWith('summary:updated', {
      consultationId: 'c-1',
      reason: 'drafted',
    });
    // No assignee (e.g. requeued): doctors only.
    service.notifySummaryUpdated({ consultationId: 'c-2', claimedBy: null, reason: 'ended' });
    expect(server.to).toHaveBeenLastCalledWith(['signoff']);
    service.notifyAttachmentCreated('c-1');
    expect(server.to).toHaveBeenLastCalledWith('consultation:c-1');
    expect(room.emit).toHaveBeenLastCalledWith('attachment:created', { consultationId: 'c-1' });
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
