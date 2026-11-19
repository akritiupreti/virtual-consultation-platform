import { INestApplication } from '@nestjs/common';
import { ConsultationState, Role } from '@prisma/client';
import request from 'supertest';
import { PrismaService } from '../../src/prisma/prisma.service';
import { createTestApp, createUser, login, resetDb } from './helpers';

/**
 * Doctor sign-off of a nurse-run case (ADR-0018). A nurse runs a consultation and
 * drafts the summary; the case ends in ENDED with no doctor participant. A
 * different doctor must be able to discover it (pending-signoff worklist), read
 * the detail + draft (sign-off read window), and finalize it (ENDED → SUMMARIZED),
 * with the sign-off audited — while patients and nurses are denied the worklist.
 */
describe('doctor sign-off of a nurse-run case (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let server: ReturnType<INestApplication['getHttpServer']>;

  const bearer = (token: string): string => `Bearer ${token}`;

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

  it('a nurse drafts a summary and a different doctor finds, reviews and finalizes it', async () => {
    // Patient submits intake.
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

    // A nurse runs the entire case; a separate doctor will sign off (never claims it).
    const nurse = await createUser(prisma, Role.NURSE, 'nurse@test.local');
    await createUser(prisma, Role.DOCTOR, 'doctor@test.local');
    const nurseToken = await login(app, 'nurse@test.local');
    const doctorToken = await login(app, 'doctor@test.local');

    await request(server)
      .post(`/consultations/${consultationId}/claim`)
      .set('Authorization', bearer(nurseToken))
      .expect(200);
    await request(server)
      .post(`/consultations/${consultationId}/start`)
      .set('Authorization', bearer(nurseToken))
      .expect(200);

    // Before the case ends, the non-participant doctor cannot read it (membership).
    await request(server)
      .get(`/consultations/${consultationId}`)
      .set('Authorization', bearer(doctorToken))
      .expect(403);

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

    // Patients and nurses cannot see the doctor-only sign-off worklist.
    await request(server)
      .get('/consultations/pending-signoff')
      .set('Authorization', bearer(patientToken))
      .expect(403);
    await request(server)
      .get('/consultations/pending-signoff')
      .set('Authorization', bearer(nurseToken))
      .expect(403);

    // The doctor discovers the case under pending sign-off (minimal detail only).
    const pending = await request(server)
      .get('/consultations/pending-signoff')
      .set('Authorization', bearer(doctorToken))
      .expect(200);
    expect(pending.body).toHaveLength(1);
    expect(pending.body[0]).toMatchObject({
      id: consultationId,
      symptomCategory: 'RESPIRATORY',
      draftedBy: nurse.id,
    });
    // The worklist must not leak the summary text.
    expect(JSON.stringify(pending.body)).not.toContain('viral URTI');

    // The non-participant doctor may now read the detail and the drafted summary.
    const detail = await request(server)
      .get(`/consultations/${consultationId}`)
      .set('Authorization', bearer(doctorToken))
      .expect(200);
    expect(detail.body.state).toBe(ConsultationState.ENDED);
    expect(detail.body.intake.chiefComplaint).toContain('cough');

    const draft = await request(server)
      .get(`/consultations/${consultationId}/summary`)
      .set('Authorization', bearer(doctorToken))
      .expect(200);
    expect(draft.body.content).toContain('viral URTI');
    expect(draft.body.finalized).toBe(false);

    // The doctor finalizes: ENDED → SUMMARIZED.
    const finalize = await request(server)
      .post(`/consultations/${consultationId}/summary/finalize`)
      .set('Authorization', bearer(doctorToken))
      .expect(200);
    expect(finalize.body.finalized).toBe(true);

    const doctorRow = await prisma.user.findUniqueOrThrow({
      where: { email: 'doctor@test.local' },
    });

    // The finalizing doctor keeps read access to the summary they signed, even now
    // that the case is SUMMARIZED and they are not a participant (ADR-0020).
    const afterSummary = await request(server)
      .get(`/consultations/${consultationId}/summary`)
      .set('Authorization', bearer(doctorToken))
      .expect(200);
    expect(afterSummary.body.finalized).toBe(true);
    expect(afterSummary.body.finalizedBy).toBe(doctorRow.id);
    expect(afterSummary.body.content).toContain('viral URTI');

    // The sign-off read window is scoped to ENDED: once the case is SUMMARIZED the
    // non-participant doctor can no longer read the consultation DETAIL (intake) —
    // membership-scoping restored (ADR-0018). Only the signed summary (above) stays.
    await request(server)
      .get(`/consultations/${consultationId}`)
      .set('Authorization', bearer(doctorToken))
      .expect(403);

    // The participant nurse still reads it, now terminal.
    const after = await request(server)
      .get(`/consultations/${consultationId}`)
      .set('Authorization', bearer(nurseToken))
      .expect(200);
    expect(after.body.state).toBe(ConsultationState.SUMMARIZED);

    // Once finalized the case leaves the worklist.
    const pendingAfter = await request(server)
      .get('/consultations/pending-signoff')
      .set('Authorization', bearer(doctorToken))
      .expect(200);
    expect(pendingAfter.body).toHaveLength(0);

    // ...and is kept on the doctor's own sign-off history (ADR-0023), minimal fields
    // only; another doctor's history does not include it.
    const history = await request(server)
      .get('/consultations/signed-off')
      .set('Authorization', bearer(doctorToken))
      .expect(200);
    expect(history.body).toHaveLength(1);
    expect(history.body[0]).toMatchObject({ id: consultationId, draftedBy: nurse.id });
    expect(JSON.stringify(history.body)).not.toContain('viral URTI');
    await createUser(prisma, Role.DOCTOR, 'doctor2@test.local');
    const otherDoctorToken = await login(app, 'doctor2@test.local');
    const otherDoctorHistory = await request(server)
      .get('/consultations/signed-off')
      .set('Authorization', bearer(otherDoctorToken))
      .expect(200);
    expect(otherDoctorHistory.body).toHaveLength(0);
    // Doctor-only.
    await request(server)
      .get('/consultations/signed-off')
      .set('Authorization', bearer(nurseToken))
      .expect(403);

    // Sign-off is audited: finalizing doctor is the actor, nurse is recorded as drafter,
    // and no summary text leaks into the audit metadata.
    const finalized = await prisma.auditLog.findFirst({
      where: { consultationId, eventType: 'SUMMARY_FINALIZED' },
    });
    expect(finalized?.actorId).toBe(doctorRow.id);
    expect(finalized?.metadata).toMatchObject({ draftedBy: nurse.id });
    expect(JSON.stringify(finalized?.metadata ?? {})).not.toContain('viral URTI');
  });
});
