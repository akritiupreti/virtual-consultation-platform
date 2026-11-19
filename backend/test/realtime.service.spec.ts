import { ConsultationState } from '@prisma/client';
import { RealtimeService } from '../src/realtime/realtime.service';

/**
 * Unit coverage for the real-time publisher (ADR-0004/0007): emits are safe no-ops
 * with no server attached, and each event reaches exactly the intended rooms.
 */
function emitter() {
  return { emit: jest.fn() };
}

describe('RealtimeService (unit)', () => {
  it('is a safe no-op when no socket server is attached', async () => {
    const prisma = { consultation: { findMany: jest.fn().mockResolvedValue([]) } };
    const service = new RealtimeService(prisma as never);
    expect(() =>
      service.broadcastConsultationUpdated({
        id: 'c-1',
        patientId: 'p',
        state: ConsultationState.ENDED,
      }),
    ).not.toThrow();
    service.broadcastMessage({ consultationId: 'c-1', message: {} as never });
    service.disconnectUser('u');
    await expect(service.recomputeQueuePositions()).resolves.toBeUndefined();
  });

  it('signals the queue and pushes each waiting patient their position', async () => {
    const prisma = {
      consultation: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'c-1', patientId: 'p1' },
          { id: 'c-2', patientId: 'p2' },
        ]),
      },
    };
    const service = new RealtimeService(prisma as never);
    const room = emitter();
    const server = { to: jest.fn(() => room) };
    service.setServer(server as never);
    await service.notifyQueueChanged('claimed', 'c-1');
    expect(server.to).toHaveBeenCalledWith('queue');
    expect(room.emit).toHaveBeenCalledWith('queue:updated', {
      reason: 'claimed',
      consultationId: 'c-1',
    });
    expect(server.to).toHaveBeenCalledWith('user:p2');
    expect(room.emit).toHaveBeenCalledWith('position:updated', {
      consultationId: 'c-2',
      state: ConsultationState.QUEUED,
      position: 1,
    });
  });

  it('fans consultation state out to the room, the patient and the assigned clinician once', () => {
    const service = new RealtimeService({} as never);
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
    const service = new RealtimeService({} as never);
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
  });
});
