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

  it('getMine resolves queued positions from a single ordered read (no per-row N+1)', async () => {
    const { service, prisma } = build();
    prisma.consultation.findMany
      // 1) the patient's own consultations (newest first)
      .mockResolvedValueOnce([
        row({ id: 'c-1', state: ConsultationState.QUEUED, summary: null }),
        row({
          id: 'c-0',
          state: ConsultationState.SUMMARIZED,
          summary: { finalizedAt: new Date() },
        }),
      ])
      // 2) the ordered queue in serving order (one read for every queued case)
      .mockResolvedValueOnce([{ id: 'c-9' }, { id: 'c-1' }]);
    const mine = await service.getMine(patient);
    expect(mine[0].position).toBe(1); // c-1 is second in serving order → 1 ahead
    expect(mine[1].position).toBeNull(); // non-queued cases carry no position
    expect(mine[1].summaryAvailable).toBe(true);
    expect(prisma.consultation.findMany).toHaveBeenCalledTimes(2);
  });

  it('getMine skips the queue read when the patient has no queued case', async () => {
    const { service, prisma } = build();
    prisma.consultation.findMany.mockResolvedValueOnce([
      row({ id: 'c-0', state: ConsultationState.SUMMARIZED, summary: null }),
    ]);
    const mine = await service.getMine(patient);
    expect(mine[0].position).toBeNull();
    expect(prisma.consultation.findMany).toHaveBeenCalledTimes(1);
  });

  it('submitRequest computes the new position from the DB on a cache miss', async () => {
    const { service, prisma } = build(null); // getCachedPosition → null
    prisma.$transaction.mockImplementation(async (cb: (tx: unknown) => unknown) =>
      cb({
        consultation: {
          create: jest.fn().mockResolvedValue({ id: 'c-1' }),
          update: jest.fn().mockResolvedValue(row({ state: ConsultationState.QUEUED })),
        },
      }),
    );
    prisma.consultation.count.mockResolvedValue(3);
    const view = await service.submitRequest(patient, {
      chiefComplaint: 'synthetic',
      symptomCategory: 'GENERAL',
      onsetDuration: '1 day',
      severity: 2,
      consent: true,
    } as never);
    expect(view.position).toBe(3);
  });

  it('getAssigned lists a clinician own cases newest-first with a trimmed complaint', async () => {
    const { service, prisma } = build();
    prisma.consultation.findMany.mockResolvedValue([
      row({
        id: 'c-2',
        state: ConsultationState.ENDED,
        claimedBy: 'doc',
        claimedAt: new Date('2026-10-22T10:00:00Z'),
        intake: { symptomCategory: 'RESPIRATORY', chiefComplaint: 'x'.repeat(150) },
        summary: { finalizedAt: new Date() },
      }),
      row({
        id: 'c-1',
        state: ConsultationState.CLAIMED,
        claimedBy: 'doc',
        claimedAt: new Date('2026-10-22T09:00:00Z'),
        intake: null,
        summary: null,
      }),
    ]);
    const assigned = await service.getAssigned(doctor);
    expect(prisma.consultation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { claimedBy: 'doc' }, orderBy: { claimedAt: 'desc' } }),
    );
    expect(assigned[0]).toMatchObject({
      id: 'c-2',
      summaryFinalized: true,
      symptomCategory: 'RESPIRATORY',
    });
    expect(assigned[0].complaintSummary).toHaveLength(100); // narrative trimmed
    expect(assigned[1]).toMatchObject({
      id: 'c-1',
      summaryFinalized: false,
      symptomCategory: null,
      complaintSummary: '',
    });
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

  it('lists pending sign-off cases with minimal detail, oldest-ended first (no summary text)', async () => {
    const { service, prisma } = build();
    prisma.consultation.findMany.mockResolvedValue([
      {
        id: 'c-1',
        priority: Priority.URGENT,
        endedAt: new Date('2026-10-22T09:00:00Z'),
        intake: { symptomCategory: 'RESPIRATORY', chiefComplaint: 'Cough and fever for two days' },
        summary: { draftedBy: 'nurse-1', createdAt: new Date('2026-10-22T09:05:00Z') },
      },
    ]);
    const rows = await service.getPendingSignoff();

    // Query targets ENDED cases whose summary exists and is unfinalized.
    expect(prisma.consultation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { state: ConsultationState.ENDED, summary: { is: { finalizedAt: null } } },
        orderBy: { endedAt: 'asc' },
      }),
    );
    expect(rows).toEqual([
      {
        id: 'c-1',
        priority: Priority.URGENT,
        symptomCategory: 'RESPIRATORY',
        complaintSummary: 'Cough and fever for two days',
        endedAt: new Date('2026-10-22T09:00:00Z'),
        draftedBy: 'nurse-1',
        draftedAt: new Date('2026-10-22T09:05:00Z'),
      },
    ]);
    // Minimal view must never carry the summary content.
    expect(JSON.stringify(rows)).not.toContain('content');
  });
});
