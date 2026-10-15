import { INestApplication } from '@nestjs/common';
import { ConsultationState, Role, UserStatus } from '@prisma/client';
import request from 'supertest';
import { AUDIT_EVENTS } from '../../src/audit/audit-events';
import { PrismaService } from '../../src/prisma/prisma.service';
import { createTestApp, createUser, login, resetDb } from './helpers';

/**
 * FR-23/24/25 (C12): account deactivation is a soft state change. A deactivated
 * user cannot log in and any already-issued token stops working; a clinician
 * deactivated mid-session has their active case paused and requeued (reassigned),
 * and every step is audited. Reactivation restores access.
 */
describe('Account deactivation lifecycle (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let server: ReturnType<INestApplication['getHttpServer']>;

  let adminToken: string;
  let nurseId: string;
  let patientId: string;

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
    const admin = await createUser(prisma, Role.ADMIN, 'admin@test.local');
    const nurse = await createUser(prisma, Role.NURSE, 'nurse@test.local');
    const patient = await createUser(prisma, Role.PATIENT, 'patient@test.local');
    void admin;
    nurseId = nurse.id;
    patientId = patient.id;
    adminToken = await login(app, 'admin@test.local');
  });

  it('blocks login and existing tokens for a deactivated user', async () => {
    const patientToken = await login(app, 'patient@test.local');
    // Token works before deactivation.
    await request(server).get('/auth/me').set('Authorization', bearer(patientToken)).expect(200);

    await request(server)
      .post(`/users/${patientId}/deactivate`)
      .set('Authorization', bearer(adminToken))
      .expect(200);

    // Existing token is now rejected (status re-checked on every request).
    await request(server).get('/auth/me').set('Authorization', bearer(patientToken)).expect(401);
    // And a fresh login is refused.
    await request(server)
      .post('/auth/login')
      .send({ email: 'patient@test.local', password: 'Password123!' })
      .expect(401);
  });

  it('reassigns a clinician’s in-session case when they are deactivated mid-session', async () => {
    const patientToken = await login(app, 'patient@test.local');
    const nurseToken = await login(app, 'nurse@test.local');

    const submit = await request(server)
      .post('/consultations')
      .set('Authorization', bearer(patientToken))
      .send({
        chiefComplaint: 'Chest tightness',
        symptomCategory: 'CARDIAC',
        onsetDuration: '1 hour',
        severity: 4,
        consent: true,
      })
      .expect(201);
    const consultationId = submit.body.id;

    await request(server)
      .post(`/consultations/${consultationId}/claim`)
      .set('Authorization', bearer(nurseToken))
      .expect(200);
    await request(server)
      .post(`/consultations/${consultationId}/start`)
      .set('Authorization', bearer(nurseToken))
      .expect(200);

    const res = await request(server)
      .post(`/users/${nurseId}/deactivate`)
      .set('Authorization', bearer(adminToken))
      .expect(200);
    expect(res.body.reassignedConsultationIds).toContain(consultationId);

    // The case is back in the queue, unassigned, and startedAt cleared.
    const after = await prisma.consultation.findUniqueOrThrow({ where: { id: consultationId } });
    expect(after.state).toBe(ConsultationState.QUEUED);
    expect(after.claimedBy).toBeNull();
    expect(after.startedAt).toBeNull();

    // Both the user-management and the reassignment are audited (who/what/when only).
    const events = await prisma.auditLog.findMany({ where: { consultationId } });
    expect(events.map((e) => e.eventType)).toContain(AUDIT_EVENTS.CONSULTATION_REASSIGNED);
    const userEvents = await prisma.auditLog.findMany({
      where: { eventType: AUDIT_EVENTS.USER_DEACTIVATED },
    });
    expect(userEvents).toHaveLength(1);

    // The deactivated clinician can no longer act.
    await request(server).get('/auth/me').set('Authorization', bearer(nurseToken)).expect(401);
  });

  it('refuses to let an admin deactivate their own account', async () => {
    const admin = await prisma.user.findUniqueOrThrow({ where: { email: 'admin@test.local' } });
    await request(server)
      .post(`/users/${admin.id}/deactivate`)
      .set('Authorization', bearer(adminToken))
      .expect(400);
  });

  it('is idempotent-safe: deactivating an already-deactivated user is 409', async () => {
    await request(server)
      .post(`/users/${nurseId}/deactivate`)
      .set('Authorization', bearer(adminToken))
      .expect(200);
    await request(server)
      .post(`/users/${nurseId}/deactivate`)
      .set('Authorization', bearer(adminToken))
      .expect(409);
  });

  it('reactivates a user and restores login', async () => {
    await request(server)
      .post(`/users/${patientId}/deactivate`)
      .set('Authorization', bearer(adminToken))
      .expect(200);
    await request(server)
      .post(`/users/${patientId}/reactivate`)
      .set('Authorization', bearer(adminToken))
      .expect(200);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: patientId } });
    expect(user.status).toBe(UserStatus.ACTIVE);
    await request(server)
      .post('/auth/login')
      .send({ email: 'patient@test.local', password: 'Password123!' })
      .expect(200);
  });
});
