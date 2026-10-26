import { INestApplication } from '@nestjs/common';
import { ConsultationState, Role } from '@prisma/client';
import request from 'supertest';
import { PrismaService } from '../../src/prisma/prisma.service';
import { createTestApp, createUser, login, resetDb } from './helpers';

/**
 * Doctor sign-off of a nurse-run case (ADR-0020). A nurse runs a consultation and
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
    // that the case is SUMMARIZED and they are not a participant (ADR-0023).
    const afterSummary = await request(server)
      .get(`/consultations/${consultationId}/summary`)
      .set('Authorization', bearer(doctorToken))
      .expect(200);
    expect(afterSummary.body.finalized).toBe(true);
    expect(afterSummary.body.finalizedBy).toBe(doctorRow.id);
    expect(afterSummary.body.content).toContain('viral URTI');

    // The sign-off read window is scoped to ENDED: once the case is SUMMARIZED the
    // non-participant doctor can no longer read the consultation DETAIL (intake) —
    // membership-scoping restored (ADR-0020). Only the signed summary (above) stays.
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

    // ...and is kept on the doctor's own sign-off history (ADR-0029), minimal fields
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

  it('a doctor returns a draft for changes; the nurse revises and the doctor then finalizes', async () => {
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

    // A nurse runs the case and drafts; a separate doctor reviews.
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
    await request(server)
      .post(`/consultations/${consultationId}/complete`)
      .set('Authorization', bearer(nurseToken))
      .expect(200);
    await request(server)
      .post(`/consultations/${consultationId}/summary`)
      .set('Authorization', bearer(nurseToken))
      .send({ content: 'Likely viral URTI.' })
      .expect(201);

    // The doctor disagrees and returns the draft for changes instead of signing it.
    const requested = await request(server)
      .post(`/consultations/${consultationId}/summary/request-changes`)
      .set('Authorization', bearer(doctorToken))
      .send({ note: 'Please add the recorded blood pressure.' })
      .expect(200);
    // The draft is untouched and still not finalized; no state transition happened.
    expect(requested.body.finalized).toBe(false);
    expect(requested.body.content).toBe('Likely viral URTI.');
    // The request is persisted durably on the summary, with the note (ADR-0025).
    expect(requested.body.changesRequestedAt).not.toBeNull();
    expect(requested.body.changesRequestedNote).toBe('Please add the recorded blood pressure.');

    // The nurse sees a durable "changes requested" marker on their assigned list,
    // even without having caught the live toast.
    const assigned = await request(server)
      .get('/consultations/assigned')
      .set('Authorization', bearer(nurseToken))
      .expect(200);
    expect(assigned.body.find((c: { id: string }) => c.id === consultationId)).toMatchObject({
      summaryChangesRequested: true,
    });

    // The case is still ENDED, so it remains on the sign-off worklist for later.
    const stillPending = await request(server)
      .get('/consultations/pending-signoff')
      .set('Authorization', bearer(doctorToken))
      .expect(200);
    expect(stillPending.body).toHaveLength(1);

    const doctorRow = await prisma.user.findUniqueOrThrow({
      where: { email: 'doctor@test.local' },
    });
    // The request is audited (who/what/when + the drafter who must act) — never the note.
    const changeEvent = await prisma.auditLog.findFirst({
      where: { consultationId, eventType: 'SUMMARY_CHANGES_REQUESTED' },
    });
    expect(changeEvent?.actorId).toBe(doctorRow.id);
    expect(changeEvent?.metadata).toMatchObject({ draftedBy: nurse.id });
    expect(JSON.stringify(changeEvent?.metadata ?? {})).not.toContain('blood pressure');

    // The assigned nurse revises the draft (still allowed in ENDED). Saving clears
    // the pending change request (ADR-0025).
    const revised = await request(server)
      .post(`/consultations/${consultationId}/summary`)
      .set('Authorization', bearer(nurseToken))
      .send({ content: 'Likely viral URTI. BP 120/80 recorded.' })
      .expect(201);
    expect(revised.body.content).toContain('BP 120/80');
    expect(revised.body.changesRequestedAt).toBeNull();
    expect(revised.body.changesRequestedNote).toBeNull();

    const assignedAfter = await request(server)
      .get('/consultations/assigned')
      .set('Authorization', bearer(nurseToken))
      .expect(200);
    expect(assignedAfter.body.find((c: { id: string }) => c.id === consultationId)).toMatchObject({
      summaryChangesRequested: false,
    });

    // The doctor is now satisfied and finalizes: ENDED → SUMMARIZED.
    const finalize = await request(server)
      .post(`/consultations/${consultationId}/summary/finalize`)
      .set('Authorization', bearer(doctorToken))
      .expect(200);
    expect(finalize.body.finalized).toBe(true);
    expect(finalize.body.content).toContain('BP 120/80');
  });

  it('a nurse cannot request changes — finalize/return is doctor-only (ADR-0024)', async () => {
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

    await createUser(prisma, Role.NURSE, 'nurse@test.local');
    const nurseToken = await login(app, 'nurse@test.local');

    await request(server)
      .post(`/consultations/${consultationId}/claim`)
      .set('Authorization', bearer(nurseToken))
      .expect(200);
    await request(server)
      .post(`/consultations/${consultationId}/start`)
      .set('Authorization', bearer(nurseToken))
      .expect(200);
    await request(server)
      .post(`/consultations/${consultationId}/complete`)
      .set('Authorization', bearer(nurseToken))
      .expect(200);
    await request(server)
      .post(`/consultations/${consultationId}/summary`)
      .set('Authorization', bearer(nurseToken))
      .send({ content: 'Likely viral URTI.' })
      .expect(201);

    // The drafting nurse cannot request changes on their own draft — role gate (403).
    await request(server)
      .post(`/consultations/${consultationId}/summary/request-changes`)
      .set('Authorization', bearer(nurseToken))
      .send({ note: 'self-review' })
      .expect(403);
  });
});
