import { INestApplication } from '@nestjs/common';
import { ConsultationState, Priority, Role } from '@prisma/client';
import request from 'supertest';
import { ConsultationsService } from '../../src/consultations/consultations.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { createTestApp, createUser, login, resetDb } from './helpers';

/**
 * SC-2 / FR-9 / ADR-0003: a contested claim is resolved in the database. Firing
 * many simultaneous claims against one queued consultation must yield exactly one
 * winner; everyone else gets "already claimed" (409). This is the concurrency
 * guarantee the whole design hinges on, so it is proven two ways.
 */
describe('claim concurrency (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let service: ConsultationsService;

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    service = app.get(ConsultationsService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDb(prisma);
  });

  async function queuedConsultation(): Promise<string> {
    const patient = await createUser(prisma, Role.PATIENT, 'patient@test.local');
    const view = await service.submitRequest(
      { id: patient.id, role: Role.PATIENT },
      {
        chiefComplaint: 'Chest tightness',
        symptomCategory: 'CARDIAC',
        onsetDuration: '1 hour',
        severity: 4,
        consent: true,
        priority: Priority.URGENT,
      },
    );
    return view.id;
  }

  it('exactly one of eight concurrent service claims wins (DB-atomic)', async () => {
    const consultationId = await queuedConsultation();

    const nurses = await Promise.all(
      Array.from({ length: 8 }, (_, i) => createUser(prisma, Role.NURSE, `nurse${i}@test.local`)),
    );

    const outcomes = await Promise.allSettled(
      nurses.map((n) => service.claim({ id: n.id, role: Role.NURSE }, consultationId)),
    );

    const winners = outcomes.filter((o) => o.status === 'fulfilled');
    const losers = outcomes.filter((o) => o.status === 'rejected');
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(7);

    const persisted = await prisma.consultation.findUniqueOrThrow({
      where: { id: consultationId },
    });
    expect(persisted.state).toBe(ConsultationState.CLAIMED);
    expect(nurses.map((n) => n.id)).toContain(persisted.claimedBy);
  });

  it('exactly one of five concurrent HTTP claims returns 200, the rest 409', async () => {
    const consultationId = await queuedConsultation();

    const tokens = await Promise.all(
      Array.from({ length: 5 }, async (_, i) => {
        await createUser(prisma, Role.NURSE, `clinician${i}@test.local`);
        return login(app, `clinician${i}@test.local`);
      }),
    );

    const responses = await Promise.all(
      tokens.map((token) =>
        request(app.getHttpServer())
          .post(`/consultations/${consultationId}/claim`)
          .set('Authorization', `Bearer ${token}`),
      ),
    );

    const statuses = responses.map((r) => r.status);
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(4);
  });
});
