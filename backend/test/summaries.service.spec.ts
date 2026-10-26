import { ConflictException, NotFoundException } from '@nestjs/common';
import { ConsultationState, Role } from '@prisma/client';
import {
  ForbiddenActionException,
  SummaryFinalizedException,
} from '../src/common/errors/domain-exceptions';
import { SummariesService } from '../src/summaries/summaries.service';

/**
 * Unit coverage for the summary rules that the e2e lifecycle does not exercise
 * in full — the immutability guards and the append-only addendum flow (FR-13 /
 * C5). Prisma + audit + realtime are mocked; the real authorization policy runs.
 */
function makePrisma() {
  return {
    consultation: { findUnique: jest.fn(), updateMany: jest.fn() },
    summary: { findUnique: jest.fn(), upsert: jest.fn(), update: jest.fn() },
    addendum: { create: jest.fn(), findMany: jest.fn() },
    $transaction: jest.fn(),
  };
}

const doctor = { id: 'doc', role: Role.DOCTOR };
const consultation = (state: ConsultationState) => ({
  patientId: 'pat',
  claimedBy: 'doc',
  state,
});

function build(prisma: ReturnType<typeof makePrisma>) {
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const realtime = {
    broadcastConsultationUpdated: jest.fn(),
    notifySummaryChangesRequested: jest.fn(),
  };
  const service = new SummariesService(prisma as never, audit as never, realtime as never);
  return { service, audit, realtime };
}

describe('SummariesService (unit)', () => {
  it('404s when the consultation does not exist', async () => {
    const prisma = makePrisma();
    prisma.consultation.findUnique.mockResolvedValue(null);
    const { service } = build(prisma);
    await expect(service.draft(doctor, 'c-1', { content: 'x' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('drafts a summary for the assigned clinician in session', async () => {
    const prisma = makePrisma();
    prisma.consultation.findUnique.mockResolvedValue(consultation(ConsultationState.IN_SESSION));
    prisma.summary.findUnique.mockResolvedValue(null);
    prisma.summary.upsert.mockResolvedValue({
      consultationId: 'c-1',
      content: 'note',
      draftedBy: 'doc',
      finalizedBy: null,
      finalizedAt: null,
    });
    const { service, audit } = build(prisma);
    const view = await service.draft(doctor, 'c-1', { content: 'note' });
    expect(view.finalized).toBe(false);
    expect(audit.record).toHaveBeenCalled();
  });

  it('refuses to re-draft a finalized summary', async () => {
    const prisma = makePrisma();
    prisma.consultation.findUnique.mockResolvedValue(consultation(ConsultationState.ENDED));
    prisma.summary.findUnique.mockResolvedValue({ finalizedAt: new Date() });
    const { service } = build(prisma);
    await expect(service.draft(doctor, 'c-1', { content: 'x' })).rejects.toBeInstanceOf(
      SummaryFinalizedException,
    );
  });

  it('refuses to finalize when there is no draft', async () => {
    const prisma = makePrisma();
    prisma.consultation.findUnique.mockResolvedValue(consultation(ConsultationState.ENDED));
    prisma.summary.findUnique.mockResolvedValue(null);
    const { service } = build(prisma);
    await expect(service.finalize(doctor, 'c-1')).rejects.toBeInstanceOf(ConflictException);
  });

  it('refuses to finalize an already-finalized summary', async () => {
    const prisma = makePrisma();
    prisma.consultation.findUnique.mockResolvedValue(consultation(ConsultationState.ENDED));
    prisma.summary.findUnique.mockResolvedValue({ finalizedAt: new Date() });
    const { service } = build(prisma);
    await expect(service.finalize(doctor, 'c-1')).rejects.toBeInstanceOf(SummaryFinalizedException);
  });

  it('aborts finalize if the consultation moved out of ENDED under it', async () => {
    const prisma = makePrisma();
    prisma.consultation.findUnique.mockResolvedValue(consultation(ConsultationState.ENDED));
    prisma.summary.findUnique.mockResolvedValue({ finalizedAt: null });
    prisma.$transaction.mockImplementation(async (cb: (tx: unknown) => unknown) =>
      cb({
        summary: { update: jest.fn().mockResolvedValue({}) },
        consultation: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      }),
    );
    const { service } = build(prisma);
    await expect(service.finalize(doctor, 'c-1')).rejects.toBeInstanceOf(ConflictException);
  });

  it('finalizes, audits and broadcasts', async () => {
    const prisma = makePrisma();
    prisma.consultation.findUnique.mockResolvedValue(consultation(ConsultationState.ENDED));
    prisma.summary.findUnique.mockResolvedValue({ finalizedAt: null });
    prisma.$transaction.mockImplementation(async (cb: (tx: unknown) => unknown) =>
      cb({
        summary: {
          update: jest.fn().mockResolvedValue({
            consultationId: 'c-1',
            content: 'note',
            draftedBy: 'doc',
            finalizedBy: 'doc',
            finalizedAt: new Date(),
          }),
        },
        consultation: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      }),
    );
    const { service, audit, realtime } = build(prisma);
    const view = await service.finalize(doctor, 'c-1');
    expect(view.finalized).toBe(true);
    expect(audit.record).toHaveBeenCalled();
    expect(realtime.broadcastConsultationUpdated).toHaveBeenCalled();
  });

  it('hides a draft summary from the patient until finalized', async () => {
    const prisma = makePrisma();
    prisma.consultation.findUnique.mockResolvedValue({
      patientId: 'pat',
      claimedBy: 'doc',
      state: ConsultationState.IN_SESSION,
    });
    prisma.summary.findUnique.mockResolvedValue({
      consultationId: 'c-1',
      content: 'note',
      draftedBy: 'doc',
      finalizedBy: null,
      finalizedAt: null,
      addenda: [],
    });
    const { service } = build(prisma);
    const patient = { id: 'pat', role: Role.PATIENT };
    await expect(service.get(patient, 'c-1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('lets the finalizing doctor read a nurse-run summary after sign-off (ADR-0023)', async () => {
    const prisma = makePrisma();
    // A nurse ran the case; the signing doctor ('doc') is not a participant.
    prisma.consultation.findUnique.mockResolvedValue({
      patientId: 'pat',
      claimedBy: 'nurse',
      state: ConsultationState.SUMMARIZED,
    });
    prisma.summary.findUnique.mockResolvedValue({
      consultationId: 'c-1',
      content: 'Likely viral URTI.',
      draftedBy: 'nurse',
      finalizedBy: 'doc',
      finalizedAt: new Date(),
      addenda: [],
    });
    const { service } = build(prisma);
    const view = await service.get(doctor, 'c-1');
    expect(view.finalized).toBe(true);
    expect(view.finalizedBy).toBe('doc');
  });

  it('still denies a different doctor the finalized summary (ADR-0023 is finalizer-scoped)', async () => {
    const prisma = makePrisma();
    prisma.consultation.findUnique.mockResolvedValue({
      patientId: 'pat',
      claimedBy: 'nurse',
      state: ConsultationState.SUMMARIZED,
    });
    prisma.summary.findUnique.mockResolvedValue({
      consultationId: 'c-1',
      content: 'Likely viral URTI.',
      draftedBy: 'nurse',
      finalizedBy: 'other-doc',
      finalizedAt: new Date(),
      addenda: [],
    });
    const { service } = build(prisma);
    await expect(service.get(doctor, 'c-1')).rejects.toBeInstanceOf(ForbiddenActionException);
  });

  it('requests changes on an ENDED draft: persists, audits and notifies the drafter (ADR-0024/0025)', async () => {
    const prisma = makePrisma();
    const now = new Date();
    prisma.consultation.findUnique.mockResolvedValue(consultation(ConsultationState.ENDED));
    prisma.summary.findUnique.mockResolvedValue({
      consultationId: 'c-1',
      content: 'Likely viral URTI.',
      draftedBy: 'nurse',
      finalizedBy: null,
      finalizedAt: null,
    });
    prisma.summary.update.mockResolvedValue({
      consultationId: 'c-1',
      content: 'Likely viral URTI.',
      draftedBy: 'nurse',
      finalizedBy: null,
      finalizedAt: null,
      changesRequestedAt: now,
      changesRequestedNote: 'Please add the BP reading.',
    });
    const { service, audit, realtime } = build(prisma);
    const view = await service.requestChanges(doctor, 'c-1', {
      note: 'Please add the BP reading.',
    });

    expect(view.finalized).toBe(false);
    // The durable marker + note are persisted on the summary (ADR-0025).
    expect(prisma.summary.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { consultationId: 'c-1' },
        data: expect.objectContaining({ changesRequestedNote: 'Please add the BP reading.' }),
      }),
    );
    expect(view.changesRequestedAt).toBe(now);
    expect(view.changesRequestedNote).toBe('Please add the BP reading.');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'SUMMARY_CHANGES_REQUESTED',
        actorId: 'doc',
        metadata: { draftedBy: 'nurse' },
      }),
    );
    // The drafter is also notified live; the note travels in the realtime payload.
    expect(realtime.notifySummaryChangesRequested).toHaveBeenCalledWith('nurse', {
      consultationId: 'c-1',
      note: 'Please add the BP reading.',
    });
    // The note is never written to the audit log (invariant 6).
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain('BP reading');
  });

  it('clears a pending change request when the drafter re-drafts (ADR-0025)', async () => {
    const prisma = makePrisma();
    prisma.consultation.findUnique.mockResolvedValue(consultation(ConsultationState.ENDED));
    prisma.summary.findUnique.mockResolvedValue(null);
    prisma.summary.upsert.mockResolvedValue({
      consultationId: 'c-1',
      content: 'revised',
      draftedBy: 'doc',
      finalizedBy: null,
      finalizedAt: null,
      changesRequestedAt: null,
      changesRequestedNote: null,
    });
    const { service } = build(prisma);
    await service.draft(doctor, 'c-1', { content: 'revised' });
    expect(prisma.summary.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          changesRequestedAt: null,
          changesRequestedNote: null,
        }),
      }),
    );
  });

  it('refuses to request changes when there is no drafted summary', async () => {
    const prisma = makePrisma();
    prisma.consultation.findUnique.mockResolvedValue(consultation(ConsultationState.ENDED));
    prisma.summary.findUnique.mockResolvedValue(null);
    const { service } = build(prisma);
    await expect(service.requestChanges(doctor, 'c-1', {})).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('refuses to request changes on an already-finalized summary', async () => {
    const prisma = makePrisma();
    prisma.consultation.findUnique.mockResolvedValue(consultation(ConsultationState.SUMMARIZED));
    prisma.summary.findUnique.mockResolvedValue({ draftedBy: 'nurse', finalizedAt: new Date() });
    const { service } = build(prisma);
    await expect(service.requestChanges(doctor, 'c-1', {})).rejects.toBeInstanceOf(
      SummaryFinalizedException,
    );
  });

  it('refuses to request changes unless the case is awaiting sign-off (ENDED)', async () => {
    const prisma = makePrisma();
    prisma.consultation.findUnique.mockResolvedValue(consultation(ConsultationState.IN_SESSION));
    prisma.summary.findUnique.mockResolvedValue({ draftedBy: 'nurse', finalizedAt: null });
    const { service } = build(prisma);
    await expect(service.requestChanges(doctor, 'c-1', {})).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('forbids a nurse from requesting changes (doctor-only, ADR-0024)', async () => {
    const prisma = makePrisma();
    prisma.consultation.findUnique.mockResolvedValue(consultation(ConsultationState.ENDED));
    const nurse = { id: 'nurse', role: Role.NURSE };
    const { service } = build(prisma);
    await expect(service.requestChanges(nurse, 'c-1', {})).rejects.toBeInstanceOf(
      ForbiddenActionException,
    );
  });

  it('adds an append-only addendum to a finalized summary', async () => {
    const prisma = makePrisma();
    prisma.consultation.findUnique.mockResolvedValue(consultation(ConsultationState.SUMMARIZED));
    prisma.summary.findUnique.mockResolvedValue({ id: 's-1', finalizedAt: new Date() });
    prisma.addendum.create.mockResolvedValue({});
    prisma.addendum.findMany.mockResolvedValue([
      { id: 'a-1', authorId: 'doc', content: 'correction', createdAt: new Date() },
    ]);
    prisma.summary.findUnique.mockResolvedValueOnce({ id: 's-1', finalizedAt: new Date() });
    prisma.summary.findUnique.mockResolvedValue({
      id: 's-1',
      consultationId: 'c-1',
      content: 'note',
      draftedBy: 'doc',
      finalizedBy: 'doc',
      finalizedAt: new Date(),
    });
    const { service, audit } = build(prisma);
    const view = await service.addAddendum(doctor, 'c-1', { content: 'correction' });
    expect(view.addenda).toHaveLength(1);
    expect(audit.record).toHaveBeenCalled();
  });

  it('refuses an addendum unless the consultation is SUMMARIZED', async () => {
    const prisma = makePrisma();
    prisma.consultation.findUnique.mockResolvedValue(consultation(ConsultationState.ENDED));
    const { service } = build(prisma);
    await expect(service.addAddendum(doctor, 'c-1', { content: 'x' })).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('refuses an addendum when there is no finalized summary', async () => {
    const prisma = makePrisma();
    prisma.consultation.findUnique.mockResolvedValue(consultation(ConsultationState.SUMMARIZED));
    prisma.summary.findUnique.mockResolvedValue(null);
    const { service } = build(prisma);
    await expect(service.addAddendum(doctor, 'c-1', { content: 'x' })).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});
