import { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import request from 'supertest';
import { PrismaService } from '../../src/prisma/prisma.service';
import { createTestApp, createUser, login, resetDb } from './helpers';

/**
 * Phase 5 observability (NFR-5 / SC-15):
 * - CS-16: a request is traceable end-to-end by correlation ID — echoed on the
 *   response header and stamped on the audit rows the request produced.
 * - CS-17: readiness reflects its real dependency (PostgreSQL gates it).
 * - Metrics endpoint exposes the request + domain series (ADR-0012).
 */
describe('Observability (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let server: ReturnType<INestApplication['getHttpServer']>;

  const bearer = (t: string): string => `Bearer ${t}`;

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    server = app.getHttpServer();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('correlation ID (SC-15 / CS-16)', () => {
    it('echoes a well-formed caller-supplied ID on the response', async () => {
      const supplied = 'trace-abc123_DEF';
      const res = await request(server)
        .get('/health')
        .set('X-Correlation-Id', supplied)
        .expect(200);
      expect(res.headers['x-correlation-id']).toBe(supplied);
      expect(res.body).toMatchObject({ status: 'ok' });
    });

    it('mints an ID when none is supplied', async () => {
      const res = await request(server).get('/health').expect(200);
      expect(res.headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('ignores a malformed caller-supplied ID and mints a safe one', async () => {
      const res = await request(server)
        .get('/health')
        .set('X-Correlation-Id', 'bad id with spaces & symbols')
        .expect(200);
      expect(res.headers['x-correlation-id']).not.toContain(' ');
      expect(res.headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('propagates the ID into the audit trail of the request (REST → service → audit)', async () => {
      await resetDb(prisma);
      await createUser(prisma, Role.ADMIN, 'admin@obs.local');
      const adminToken = await login(app, 'admin@obs.local');

      await request(server)
        .post('/auth/register')
        .send({ email: 'patient@obs.local', password: 'Password123!' })
        .expect(201);
      const patientToken = await login(app, 'patient@obs.local');

      const correlationId = 'req-trace-0001';
      const submit = await request(server)
        .post('/consultations')
        .set('Authorization', bearer(patientToken))
        .set('X-Correlation-Id', correlationId)
        .send({
          chiefComplaint: 'Headache',
          symptomCategory: 'NEUROLOGICAL',
          onsetDuration: '1 day',
          severity: 3,
          consent: true,
        })
        .expect(201);
      expect(submit.headers['x-correlation-id']).toBe(correlationId);
      const consultationId = submit.body.id as string;

      const audit = await request(server)
        .get(`/audit?consultationId=${consultationId}`)
        .set('Authorization', bearer(adminToken))
        .expect(200);
      expect(audit.body.items.length).toBeGreaterThan(0);
      // Every row the submit produced carries the request's correlation ID.
      for (const row of audit.body.items as Array<{ metadata?: { correlationId?: string } }>) {
        expect(row.metadata?.correlationId).toBe(correlationId);
      }
    });
  });

  describe('readiness probe (CS-17)', () => {
    it('reports ready with PostgreSQL up (gating dependency)', async () => {
      const res = await request(server).get('/ready').expect(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.info.postgres.status).toBe('up');
    });
  });

  describe('metrics endpoint (ADR-0012)', () => {
    it('exposes process and domain series in Prometheus format', async () => {
      const res = await request(server).get('/metrics').expect(200);
      expect(res.text).toContain('process_cpu_user_seconds_total');
      expect(res.text).toContain('vcp_queue_depth');
      expect(res.text).toContain('vcp_active_consultations');
    });
  });
});
