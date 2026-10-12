import { INestApplication } from '@nestjs/common';
import { ConsultationState, Role } from '@prisma/client';
import request from 'supertest';
import { PrismaService } from '../../src/prisma/prisma.service';
import { createTestApp, createUser, login, resetDb } from './helpers';

/**
 * SC-1: the full consultation lifecycle works end-to-end, gated by the state
 * machine and role authorization, with core actions audited.
 * Requested → Queued → Claimed → In Session → Ended → Summarized.
 */
describe('consultation lifecycle (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let server: ReturnType<INestApplication['getHttpServer']>;

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    server = app.getHttpServer();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDb(prisma);
  });

  const bearer = (token: string): string => `Bearer ${token}`;

  it('drives a consultation from request to finalized summary', async () => {
    // Patient self-registers (always PATIENT) and submits intake.
    const register = await request(server)
      .post('/auth/register')
      .send({ email: 'patient@test.local', password: 'Password123!' })
      .expect(201);
    const patientToken: string = register.body.accessToken;

    const submit = await request(server)
      .post('/consultations')
      .set('Authorization', bearer(patientToken))
      .send({
        chiefComplaint: 'Persistent cough for two days',
        symptomCategory: 'RESPIRATORY',
        onsetDuration: '2 days',
        severity: 3,
        consent: true,
      })
      .expect(201);

    const consultationId: string = submit.body.id;
    expect(submit.body.state).toBe(ConsultationState.QUEUED);
    expect(submit.body.position).toBe(0);

    // Staff are provisioned (seed/admin), not self-registered.
    await createUser(prisma, Role.NURSE, 'nurse@test.local');
    await createUser(prisma, Role.DOCTOR, 'doctor@test.local');
    const nurseToken = await login(app, 'nurse@test.local');
    const doctorToken = await login(app, 'doctor@test.local');

    // Clinician sees the queue with minimal pre-claim info only (no patient identity).
    const queue = await request(server)
      .get('/consultations/queue')
      .set('Authorization', bearer(nurseToken))
      .expect(200);
    expect(queue.body).toHaveLength(1);
    expect(queue.body[0]).toMatchObject({ id: consultationId, symptomCategory: 'RESPIRATORY' });
    expect(queue.body[0].patientId).toBeUndefined();

    // Claim → Start.
    const claim = await request(server)
      .post(`/consultations/${consultationId}/claim`)
      .set('Authorization', bearer(nurseToken))
      .expect(200);
    expect(claim.body.state).toBe(ConsultationState.CLAIMED);

    await request(server)
      .post(`/consultations/${consultationId}/start`)
      .set('Authorization', bearer(nurseToken))
      .expect(200)
      .expect((res) => expect(res.body.state).toBe(ConsultationState.IN_SESSION));

    // Persisted messaging both ways.
    await request(server)
      .post(`/consultations/${consultationId}/messages`)
      .set('Authorization', bearer(patientToken))
      .send({ body: 'It is worse at night.' })
      .expect(201);
    await request(server)
      .post(`/consultations/${consultationId}/messages`)
      .set('Authorization', bearer(nurseToken))
      .send({ body: 'Any fever?' })
      .expect(201);

    const messages = await request(server)
      .get(`/consultations/${consultationId}/messages`)
      .set('Authorization', bearer(nurseToken))
      .expect(200);
    expect(messages.body).toHaveLength(2);

    // Complete, nurse drafts, doctor finalizes.
    await request(server)
      .post(`/consultations/${consultationId}/complete`)
      .set('Authorization', bearer(nurseToken))
      .expect(200)
      .expect((res) => expect(res.body.state).toBe(ConsultationState.ENDED));

    await request(server)
      .post(`/consultations/${consultationId}/summary`)
      .set('Authorization', bearer(nurseToken))
      .send({ content: 'Likely viral URTI. Advise fluids and rest.' })
      .expect(201);

    // Nurse cannot finalize — doctor-only.
    await request(server)
      .post(`/consultations/${consultationId}/summary/finalize`)
      .set('Authorization', bearer(nurseToken))
      .expect(403);

    const finalize = await request(server)
      .post(`/consultations/${consultationId}/summary/finalize`)
      .set('Authorization', bearer(doctorToken))
      .expect(200);
    expect(finalize.body.finalized).toBe(true);

    // Consultation is now terminal; patient can read their finalized summary.
    const detail = await request(server)
      .get(`/consultations/${consultationId}`)
      .set('Authorization', bearer(nurseToken))
      .expect(200);
    expect(detail.body.state).toBe(ConsultationState.SUMMARIZED);

    const patientSummary = await request(server)
      .get(`/consultations/${consultationId}/summary`)
      .set('Authorization', bearer(patientToken))
      .expect(200);
    expect(patientSummary.body.content).toContain('viral URTI');

    // Core actions were audited, and audit metadata carries no clinical content.
    const events = await prisma.auditLog.findMany({ where: { consultationId } });
    const types = events.map((e) => e.eventType);
    expect(types).toEqual(
      expect.arrayContaining([
        'CONSULTATION_REQUESTED',
        'CONSULTATION_ENQUEUED',
        'CONSULTATION_CLAIMED',
        'CONSULTATION_STARTED',
        'CONSULTATION_COMPLETED',
        'SUMMARY_FINALIZED',
      ]),
    );
    for (const event of events) {
      expect(JSON.stringify(event.metadata ?? {})).not.toContain('viral URTI');
      expect(JSON.stringify(event.metadata ?? {})).not.toContain('worse at night');
    }
  });

  it('rejects an invalid transition (completing before starting) with 409', async () => {
    const register = await request(server)
      .post('/auth/register')
      .send({ email: 'p2@test.local', password: 'Password123!' })
      .expect(201);
    const submit = await request(server)
      .post('/consultations')
      .set('Authorization', bearer(register.body.accessToken))
      .send({
        chiefComplaint: 'Headache',
        symptomCategory: 'NEUROLOGICAL',
        onsetDuration: '1 day',
        severity: 2,
        consent: true,
      })
      .expect(201);
    const id: string = submit.body.id;

    await createUser(prisma, Role.NURSE, 'nurse2@test.local');
    const nurseToken = await login(app, 'nurse2@test.local');

    await request(server)
      .post(`/consultations/${id}/claim`)
      .set('Authorization', bearer(nurseToken))
      .expect(200);

    // CLAIMED → ENDED is not a legal transition (must start first).
    await request(server)
      .post(`/consultations/${id}/complete`)
      .set('Authorization', bearer(nurseToken))
      .expect(409);
  });
});
