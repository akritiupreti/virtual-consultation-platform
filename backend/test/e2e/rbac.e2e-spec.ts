import { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import request from 'supertest';
import { PrismaService } from '../../src/prisma/prisma.service';
import { createTestApp, createUser, login, resetDb } from './helpers';

/**
 * SC-6: admins can never read clinical content (messages, summaries, consultation
 * detail) — separation of duties (invariant 3).
 * SC-7: no privilege escalation — every matrix cell marked ❌ is denied, including
 * cross-patient and non-assigned-clinician access.
 */
describe('RBAC & separation of duties (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let server: ReturnType<INestApplication['getHttpServer']>;

  let consultationId: string;
  let patientAToken: string;
  let patientBToken: string;
  let nurseToken: string;
  let otherNurseToken: string;
  let adminToken: string;

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

    const regA = await request(server)
      .post('/auth/register')
      .send({ email: 'patient-a@test.local', password: 'Password123!' })
      .expect(201);
    patientAToken = regA.body.accessToken;

    const regB = await request(server)
      .post('/auth/register')
      .send({ email: 'patient-b@test.local', password: 'Password123!' })
      .expect(201);
    patientBToken = regB.body.accessToken;

    await createUser(prisma, Role.NURSE, 'nurse@test.local');
    await createUser(prisma, Role.NURSE, 'other-nurse@test.local');
    await createUser(prisma, Role.ADMIN, 'admin@test.local');
    nurseToken = await login(app, 'nurse@test.local');
    otherNurseToken = await login(app, 'other-nurse@test.local');
    adminToken = await login(app, 'admin@test.local');

    // Patient A's consultation, taken into session with a message + a drafted summary.
    const submit = await request(server)
      .post('/consultations')
      .set('Authorization', bearer(patientAToken))
      .send({
        chiefComplaint: 'Severe abdominal pain',
        symptomCategory: 'GASTROINTESTINAL',
        onsetDuration: '6 hours',
        severity: 5,
        consent: true,
      })
      .expect(201);
    consultationId = submit.body.id;

    await request(server)
      .post(`/consultations/${consultationId}/claim`)
      .set('Authorization', bearer(nurseToken))
      .expect(200);
    await request(server)
      .post(`/consultations/${consultationId}/start`)
      .set('Authorization', bearer(nurseToken))
      .expect(200);
    await request(server)
      .post(`/consultations/${consultationId}/messages`)
      .set('Authorization', bearer(patientAToken))
      .send({ body: 'The pain is on the right side.' })
      .expect(201);
    await request(server)
      .post(`/consultations/${consultationId}/summary`)
      .set('Authorization', bearer(nurseToken))
      .send({ content: 'Query appendicitis; refer for imaging.' })
      .expect(201);
  });

  describe('admin cannot read clinical content (SC-6)', () => {
    it('is denied the messages', () =>
      request(server)
        .get(`/consultations/${consultationId}/messages`)
        .set('Authorization', bearer(adminToken))
        .expect(403));

    it('is denied the summary', () =>
      request(server)
        .get(`/consultations/${consultationId}/summary`)
        .set('Authorization', bearer(adminToken))
        .expect(403));

    it('is denied the consultation detail', () =>
      request(server)
        .get(`/consultations/${consultationId}`)
        .set('Authorization', bearer(adminToken))
        .expect(403));

    it('is denied the triage queue', () =>
      request(server)
        .get('/consultations/queue')
        .set('Authorization', bearer(adminToken))
        .expect(403));

    it('is denied sending a message into the room', () =>
      request(server)
        .post(`/consultations/${consultationId}/messages`)
        .set('Authorization', bearer(adminToken))
        .send({ body: 'hello' })
        .expect(403));

    it('can read the audit log (its one legitimate view)', () =>
      request(server).get('/audit').set('Authorization', bearer(adminToken)).expect(200));
  });

  describe('no privilege escalation (SC-7)', () => {
    it('a patient cannot view the triage queue', () =>
      request(server)
        .get('/consultations/queue')
        .set('Authorization', bearer(patientAToken))
        .expect(403));

    it('a patient cannot claim a case', () =>
      request(server)
        .post(`/consultations/${consultationId}/claim`)
        .set('Authorization', bearer(patientAToken))
        .expect(403));

    it("another patient cannot read patient A's consultation", () =>
      request(server)
        .get(`/consultations/${consultationId}`)
        .set('Authorization', bearer(patientBToken))
        .expect(403));

    it("another patient cannot read patient A's messages", () =>
      request(server)
        .get(`/consultations/${consultationId}/messages`)
        .set('Authorization', bearer(patientBToken))
        .expect(403));

    it('a non-assigned clinician cannot read the consultation detail', () =>
      request(server)
        .get(`/consultations/${consultationId}`)
        .set('Authorization', bearer(otherNurseToken))
        .expect(403));

    it('a nurse cannot finalize a summary (doctor-only)', async () => {
      await request(server)
        .post(`/consultations/${consultationId}/complete`)
        .set('Authorization', bearer(nurseToken))
        .expect(200);
      await request(server)
        .post(`/consultations/${consultationId}/summary/finalize`)
        .set('Authorization', bearer(nurseToken))
        .expect(403);
    });

    it("another patient cannot send a message into patient A's consultation", () =>
      request(server)
        .post(`/consultations/${consultationId}/messages`)
        .set('Authorization', bearer(patientBToken))
        .send({ body: 'hello' })
        .expect(403));

    it('a non-assigned clinician cannot read the messages', () =>
      request(server)
        .get(`/consultations/${consultationId}/messages`)
        .set('Authorization', bearer(otherNurseToken))
        .expect(403));

    it('a non-admin cannot list users (admin-only)', async () => {
      await request(server).get('/users').set('Authorization', bearer(nurseToken)).expect(403);
      await request(server).get('/users').set('Authorization', bearer(patientAToken)).expect(403);
    });

    it('a non-admin cannot deactivate a user (admin-only)', async () => {
      const target = await prisma.user.findUniqueOrThrow({ where: { email: 'nurse@test.local' } });
      await request(server)
        .post(`/users/${target.id}/deactivate`)
        .set('Authorization', bearer(patientAToken))
        .expect(403);
    });

    it('an unauthenticated request is rejected', () =>
      request(server).get(`/consultations/${consultationId}`).expect(401));
  });
});
