import { ConflictException, NotFoundException } from '@nestjs/common';
import { ConsultationState, Role } from '@prisma/client';
import {
  ForbiddenActionException,
  SummaryFinalizedException,
} from '../src/common/errors/domain-exceptions';
import { SummariesService } from '../src/summaries/summaries.service';

/**
 * Unit coverage for the summary rules that the e2e lifecycle does not exercise
 * in full — drafting, doctor-only finalize and the immutability guards (FR-13).
 * Prisma + audit + realtime are mocked; the real authorization policy runs.
 */
function makePrisma() {
  return {
    consultation: { findUnique: jest.fn(), updateMany: jest.fn() },
    summary: { findUnique: jest.fn(), upsert: jest.fn(), update: jest.fn() },
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
    notifySummaryUpdated: jest.fn(),
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
    const { service, audit, realtime } = build(prisma);
    const view = await service.draft(doctor, 'c-1', { content: 'note' });
    expect(view.finalized).toBe(false);
    expect(audit.record).toHaveBeenCalled();
    // A reviewing doctor's open copy reconciles live; the signal carries no text.
    expect(realtime.notifySummaryUpdated).toHaveBeenCalledWith({
      consultationId: 'c-1',
      claimedBy: 'doc',
      reason: 'drafted',
    });
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
    // The sign-off worklist and the drafter's list reconcile live (ADR-0022).
    expect(realtime.notifySummaryUpdated).toHaveBeenCalledWith(
      expect.objectContaining({ consultationId: 'c-1', reason: 'finalized' }),
    );
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
    });
    const { service } = build(prisma);
    const patient = { id: 'pat', role: Role.PATIENT };
    await expect(service.get(patient, 'c-1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('lets the finalizing doctor read a nurse-run summary after sign-off (ADR-0020)', async () => {
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
    });
    const { service } = build(prisma);
    const view = await service.get(doctor, 'c-1');
    expect(view.finalized).toBe(true);
    expect(view.finalizedBy).toBe('doc');
  });

  it('still denies a different doctor the finalized summary (ADR-0020 is finalizer-scoped)', async () => {
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
    });
    const { service } = build(prisma);
    await expect(service.get(doctor, 'c-1')).rejects.toBeInstanceOf(ForbiddenActionException);
  });
});
