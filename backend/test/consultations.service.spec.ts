import { NotFoundException } from '@nestjs/common';
import { ConsultationState, Priority, Role } from '@prisma/client';
import { IllegalTransitionException } from '../src/common/errors/domain-exceptions';
import { ConsultationsService } from '../src/consultations/consultations.service';

/**
 * Unit coverage for the consultation guards/degrade branches the e2e happy paths
 * do not reach: 404s, the non-queued re-priority guard, optimistic-conflict
 * aborts, the cached-position fast path, and clinician reassignment (ADR-0012).
 * The DB-atomic claim itself is proven end-to-end (CS-2); here Prisma is mocked.
 */
function build(cachedPosition: number | null = null) {
  const prisma = {
    consultation: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn(),
    },
    $transaction: jest.fn(),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const realtime = {
    notifyQueueChanged: jest.fn().mockResolvedValue(undefined),
    broadcastConsultationUpdated: jest.fn(),
    getCachedPosition: jest.fn().mockResolvedValue(cachedPosition),
  };
  const config = { get: jest.fn().mockReturnValue(undefined) };
  const service = new ConsultationsService(
    prisma as never,
    audit as never,
    realtime as never,
    config as never,
  );
  return { service, prisma, audit, realtime };
}

const doctor = { id: 'doc', role: Role.DOCTOR };
const patient = { id: 'pat', role: Role.PATIENT };
const row = (over: Record<string, unknown> = {}) => ({
  id: 'c-1',
  patientId: 'pat',
  claimedBy: null,
  state: ConsultationState.QUEUED,
  priority: Priority.ROUTINE,
  createdAt: new Date(),
  enqueuedAt: new Date(),
  claimedAt: null,
  startedAt: null,
  endedAt: null,
  ...over,
});

describe('ConsultationsService (unit)', () => {
  it('submits intake with defaults and enqueues in one transaction', async () => {
    const { service, prisma, realtime } = build(0);
    prisma.$transaction.mockImplementation(async (cb: (tx: unknown) => unknown) =>
      cb({
        consultation: {
          create: jest.fn().mockResolvedValue({ id: 'c-1' }),
          update: jest
            .fn()
            .mockResolvedValue(
              row({ state: ConsultationState.QUEUED, priority: Priority.ROUTINE }),
            ),
        },
      }),
    );
    const view = await service.submitRequest(patient, {
      chiefComplaint: 'synthetic',
      symptomCategory: 'GENERAL',
      onsetDuration: '2 days',
      severity: 3,
      consent: true,
    } as never);
    expect(view.state).toBe(ConsultationState.QUEUED);
    expect(realtime.notifyQueueChanged).toHaveBeenCalledWith('enqueued', 'c-1');
  });

  it('maps the pre-claim queue with safe fallbacks for missing intake', async () => {
    const { service, prisma } = build();
    prisma.consultation.findMany.mockResolvedValue([
      { id: 'c-1', priority: Priority.URGENT, enqueuedAt: null, intake: null },
    ]);
    const queue = await service.getQueue();
    expect(queue[0]).toMatchObject({ symptomCategory: 'UNKNOWN', severity: 0, waitingSeconds: 0 });
  });

  it('getMine uses the cached position fast path for queued cases', async () => {
    const { service, prisma, realtime } = build(4);
    prisma.consultation.findMany.mockResolvedValue([
      row({ state: ConsultationState.QUEUED, summary: null }),
    ]);
    const mine = await service.getMine(patient);
    expect(mine[0].position).toBe(4);
    expect(realtime.getCachedPosition).toHaveBeenCalled();
  });

  it('getMine computes the position from the DB on a cache miss', async () => {
    const { service, prisma } = build(null);
    prisma.consultation.findMany.mockResolvedValue([
      row({ state: ConsultationState.QUEUED, summary: { finalizedAt: new Date() } }),
    ]);
    prisma.consultation.count.mockResolvedValue(2);
    const mine = await service.getMine(patient);
    expect(mine[0].position).toBe(2);
    expect(mine[0].summaryAvailable).toBe(true);
  });

  it('404s getOne for a missing consultation', async () => {
    const { service, prisma } = build();
    prisma.consultation.findUnique.mockResolvedValue(null);
    await expect(service.getOne(patient, 'ghost')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('404s claim for a missing consultation', async () => {
    const { service, prisma } = build();
    prisma.consultation.findUnique.mockResolvedValue(null);
    await expect(service.claim(doctor, 'ghost')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects re-prioritizing a case that is not queued', async () => {
    const { service, prisma } = build();
    prisma.consultation.findUnique.mockResolvedValue(
      row({ state: ConsultationState.CLAIMED, claimedBy: 'doc' }),
    );
    await expect(service.setPriority(doctor, 'c-1', Priority.URGENT)).rejects.toBeInstanceOf(
      IllegalTransitionException,
    );
  });

  it('re-prioritizes a queued case and fans out', async () => {
    const { service, prisma, realtime } = build();
    prisma.consultation.findUnique.mockResolvedValue(row({ state: ConsultationState.QUEUED }));
    prisma.consultation.update.mockResolvedValue(row({ priority: Priority.URGENT }));
    const res = await service.setPriority(doctor, 'c-1', Priority.URGENT);
    expect(res.priority).toBe(Priority.URGENT);
    expect(realtime.notifyQueueChanged).toHaveBeenCalledWith('priority_changed', 'c-1');
  });

  it('aborts start when the optimistic UPDATE matches no row (409)', async () => {
    const { service, prisma } = build();
    prisma.consultation.findUnique.mockResolvedValue(
      row({ state: ConsultationState.CLAIMED, claimedBy: 'doc' }),
    );
    prisma.consultation.count.mockResolvedValue(0); // under the active cap
    prisma.consultation.updateMany.mockResolvedValue({ count: 0 }); // raced
    await expect(service.start(doctor, 'c-1')).rejects.toBeInstanceOf(IllegalTransitionException);
  });

  it('reassigns active cases of a deactivated clinician (skipping raced rows)', async () => {
    const { service, prisma, realtime } = build();
    prisma.consultation.findMany.mockResolvedValue([
      { id: 'c-1', patientId: 'p1' },
      { id: 'c-2', patientId: 'p2' },
    ]);
    prisma.consultation.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 }); // c-2 moved under us → skipped
    const ids = await service.reassignActiveCasesOf('doc', 'clinician_deactivated');
    expect(ids).toEqual(['c-1']);
    expect(realtime.notifyQueueChanged).toHaveBeenCalledWith('reassigned');
  });

  it('reassign is a no-op when the clinician has no active cases', async () => {
    const { service, prisma, realtime } = build();
    prisma.consultation.findMany.mockResolvedValue([]);
    const ids = await service.reassignActiveCasesOf('doc', 'clinician_deactivated');
    expect(ids).toEqual([]);
    expect(realtime.notifyQueueChanged).not.toHaveBeenCalled();
  });
});
