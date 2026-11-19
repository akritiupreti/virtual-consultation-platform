import { INestApplication } from '@nestjs/common';
import { ConsultationState, Priority, Role } from '@prisma/client';
import { AUDIT_EVENTS } from '../../src/audit/audit-events';
import { ConsultationsService } from '../../src/consultations/consultations.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { ClaimTtlService } from '../../src/realtime/claim-ttl.service';
import { createTestApp, createUser, resetDb } from './helpers';

/**
 * CS-8 / FR-12 / SC-4 (ADR-0008): a claim that is never started within the start
 * TTL is auto-requeued, `claimed_by` is cleared, and the requeue is audited. The
 * sweeper is driven directly (claim is back-dated past the TTL) so the assertion
 * is deterministic rather than waiting on wall-clock time.
 */
describe('claim-start TTL auto-requeue (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let consultations: ConsultationsService;
  let sweeper: ClaimTtlService;

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    consultations = app.get(ConsultationsService);
    sweeper = app.get(ClaimTtlService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDb(prisma);
  });

  async function claimedConsultation(): Promise<{ id: string; nurseId: string }> {
    const patient = await createUser(prisma, Role.PATIENT, 'patient@test.local');
    const nurse = await createUser(prisma, Role.NURSE, 'nurse@test.local');
    const view = await consultations.submitRequest(
      { id: patient.id, role: Role.PATIENT },
      {
        chiefComplaint: 'Persistent cough',
        symptomCategory: 'RESPIRATORY',
        onsetDuration: '3 days',
        severity: 3,
        consent: true,
        priority: Priority.ROUTINE,
      },
    );
    await consultations.claim({ id: nurse.id, role: Role.NURSE }, view.id);
    return { id: view.id, nurseId: nurse.id };
  }

  /** Push claimed_at far enough into the past that the case is beyond the TTL. */
  async function backdateClaim(id: string): Promise<void> {
    await prisma.consultation.update({
      where: { id },
      data: { claimedAt: new Date(Date.now() - 10 * 60 * 1000) },
    });
  }

  it('requeues a claimed-but-not-started case past the TTL and audits it', async () => {
    const { id, nurseId } = await claimedConsultation();
    await backdateClaim(id);

    // Drive the sweep directly. (A background tick is configured out of the way in
    // CI; the authoritative proof is the persisted state + the single audit row,
    // which hold regardless of which sweep performed the one atomic requeue.)
    const requeued = await sweeper.sweepExpiredClaims();
    expect(requeued).toBeLessThanOrEqual(1);

    const persisted = await prisma.consultation.findUniqueOrThrow({ where: { id } });
    expect(persisted.state).toBe(ConsultationState.QUEUED);
    expect(persisted.claimedBy).toBeNull();
    expect(persisted.claimedAt).toBeNull();
    // enqueued_at is preserved so the case regains its original queue standing.
    expect(persisted.enqueuedAt).not.toBeNull();

    const audit = await prisma.auditLog.findMany({
      where: { consultationId: id, eventType: AUDIT_EVENTS.CONSULTATION_REQUEUED },
    });
    expect(audit).toHaveLength(1);
    // System action: no actor, and never any clinical content in metadata.
    expect(audit[0].actorId).toBeNull();
    expect(audit[0].metadata).toMatchObject({
      reason: 'start_ttl_expired',
      previousClaimedBy: nurseId,
    });
  });

  it('does NOT requeue a claim still within the TTL', async () => {
    const { id } = await claimedConsultation(); // claimed just now
    const requeued = await sweeper.sweepExpiredClaims();
    expect(requeued).toBe(0);

    const persisted = await prisma.consultation.findUniqueOrThrow({ where: { id } });
    expect(persisted.state).toBe(ConsultationState.CLAIMED);
  });

  it('does NOT requeue a case that was started in time, even past the TTL', async () => {
    const { id, nurseId } = await claimedConsultation();
    await consultations.start({ id: nurseId, role: Role.NURSE }, id); // → IN_SESSION
    await backdateClaim(id);

    const requeued = await sweeper.sweepExpiredClaims();
    expect(requeued).toBe(0);

    const persisted = await prisma.consultation.findUniqueOrThrow({ where: { id } });
    expect(persisted.state).toBe(ConsultationState.IN_SESSION);
  });
});
