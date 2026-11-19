import { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import request from 'supertest';
import { AUDIT_EVENTS } from '../../src/audit/audit-events';
import { PrismaService } from '../../src/prisma/prisma.service';
import { createTestApp, createUser, login, resetDb } from './helpers';

/**
 * FR-15: the admin audit view is filterable (actor, event type, consultation, time
 * range) and paginated, and it never exposes clinical content (invariant 3; SC-6):
 * no message body or summary text ever appears in a record.
 */
const SECRET_MESSAGE = 'PRIVATE patient said the pain is sharp';
const SECRET_SUMMARY = 'CLINICAL assessment: query appendicitis';

describe('Admin audit query (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let server: ReturnType<INestApplication['getHttpServer']>;

  let adminToken: string;
  let nurseId: string;
  let consultationId: string;

  const bearer = (t: string): string => `Bearer ${t}`;

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    server = app.getHttpServer();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDb(prisma);
    await createUser(prisma, Role.ADMIN, 'admin@test.local');
    const nurse = await createUser(prisma, Role.DOCTOR, 'doc@test.local');
    nurseId = nurse.id;
    adminToken = await login(app, 'admin@test.local');
    const patientToken = await login(app, await registerPatient());
    const docToken = await login(app, 'doc@test.local');

    // Drive a full lifecycle so there is a rich, varied trail to query.
    const submit = await request(server)
      .post('/consultations')
      .set('Authorization', bearer(patientToken))
      .send({
        chiefComplaint: 'Abdominal pain',
        symptomCategory: 'GASTROINTESTINAL',
        onsetDuration: '6 hours',
        severity: 5,
        consent: true,
      })
      .expect(201);
    consultationId = submit.body.id;

    await claimStart(docToken);
    await request(server)
      .post(`/consultations/${consultationId}/messages`)
      .set('Authorization', bearer(patientToken))
      .send({ body: SECRET_MESSAGE })
      .expect(201);
    await request(server)
      .post(`/consultations/${consultationId}/summary`)
      .set('Authorization', bearer(docToken))
      .send({ content: SECRET_SUMMARY })
      .expect(201);
    await request(server)
      .post(`/consultations/${consultationId}/complete`)
      .set('Authorization', bearer(docToken))
      .expect(200);
    await request(server)
      .post(`/consultations/${consultationId}/summary/finalize`)
      .set('Authorization', bearer(docToken))
      .expect(200);
  });

  async function registerPatient(): Promise<string> {
    await request(server)
      .post('/auth/register')
      .send({ email: 'patient@test.local', password: 'Password123!' })
      .expect(201);
    return 'patient@test.local';
  }

  async function claimStart(docToken: string): Promise<void> {
    await request(server)
      .post(`/consultations/${consultationId}/claim`)
      .set('Authorization', bearer(docToken))
      .expect(200);
    await request(server)
      .post(`/consultations/${consultationId}/start`)
      .set('Authorization', bearer(docToken))
      .expect(200);
  }

  it('returns a paginated envelope and supports filtering', async () => {
    const all = await request(server)
      .get('/audit')
      .set('Authorization', bearer(adminToken))
      .expect(200);
    expect(all.body).toMatchObject({ limit: expect.any(Number), offset: 0 });
    expect(Array.isArray(all.body.items)).toBe(true);
    expect(all.body.total).toBeGreaterThan(0);

    // Filter by event type.
    const claimed = await request(server)
      .get(`/audit?eventType=${AUDIT_EVENTS.CONSULTATION_CLAIMED}`)
      .set('Authorization', bearer(adminToken))
      .expect(200);
    expect(claimed.body.items.length).toBeGreaterThan(0);
    for (const row of claimed.body.items) {
      expect(row.eventType).toBe(AUDIT_EVENTS.CONSULTATION_CLAIMED);
    }

    // Filter by consultation.
    const byConsultation = await request(server)
      .get(`/audit?consultationId=${consultationId}`)
      .set('Authorization', bearer(adminToken))
      .expect(200);
    for (const row of byConsultation.body.items) {
      expect(row.consultationId).toBe(consultationId);
    }

    // Filter by actor (the clinician).
    const byActor = await request(server)
      .get(`/audit?actorId=${nurseId}`)
      .set('Authorization', bearer(adminToken))
      .expect(200);
    expect(byActor.body.items.length).toBeGreaterThan(0);
    for (const row of byActor.body.items) {
      expect(row.actorId).toBe(nurseId);
    }
  });

  it('paginates with limit + offset', async () => {
    const page = await request(server)
      .get('/audit?limit=2&offset=0')
      .set('Authorization', bearer(adminToken))
      .expect(200);
    expect(page.body.items.length).toBeLessThanOrEqual(2);
    expect(page.body.limit).toBe(2);
  });

  it('rejects an unknown filter field (400)', () =>
    request(server).get('/audit?bogus=1').set('Authorization', bearer(adminToken)).expect(400));

  it('never exposes clinical content in any audit record (SC-6)', async () => {
    const res = await request(server)
      .get('/audit?limit=200')
      .set('Authorization', bearer(adminToken))
      .expect(200);
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain(SECRET_MESSAGE);
    expect(serialized).not.toContain(SECRET_SUMMARY);
    // Sanity: the finalize event IS present (so we know we captured real activity).
    const types = res.body.items.map((r: { eventType: string }) => r.eventType);
    expect(types).toContain(AUDIT_EVENTS.SUMMARY_FINALIZED);
  });

  it('refuses a non-admin (403)', async () => {
    const docToken = await login(app, 'doc@test.local');
    await request(server).get('/audit').set('Authorization', bearer(docToken)).expect(403);
  });
});
