import { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import request from 'supertest';
import { AUDIT_EVENTS } from '../../src/audit/audit-events';
import { PrismaService } from '../../src/prisma/prisma.service';
import { createTestApp, createUser, login, resetDb } from './helpers';

/**
 * SC-8: attachments are clinical content reachable only via scoped, short-lived
 * signed URLs — never public, never admin, membership-scoped. Covers upload type/
 * size validation, participant-only access, the signed-URL round-trip, and that a
 * tampered/mismatched token is refused. Signed-URL expiry + tamper logic is unit-
 * tested in signed-url.service.spec.ts.
 */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03]);

describe('Attachments: signed-URL access & privacy (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let server: ReturnType<INestApplication['getHttpServer']>;

  let consultationId: string;
  let patientToken: string;
  let otherPatientToken: string;
  let nurseToken: string;

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

    const regP = await request(server)
      .post('/auth/register')
      .send({ email: 'patient@test.local', password: 'Password123!' })
      .expect(201);
    patientToken = regP.body.accessToken;

    const regP2 = await request(server)
      .post('/auth/register')
      .send({ email: 'patient2@test.local', password: 'Password123!' })
      .expect(201);
    otherPatientToken = regP2.body.accessToken;

    await createUser(prisma, Role.NURSE, 'nurse@test.local');
    nurseToken = await login(app, 'nurse@test.local');

    // Take a consultation into IN_SESSION so attachments are allowed.
    const submit = await request(server)
      .post('/consultations')
      .set('Authorization', bearer(patientToken))
      .send({
        chiefComplaint: 'Rash on forearm',
        symptomCategory: 'DERMATOLOGY',
        onsetDuration: '2 days',
        severity: 2,
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
  });

  function upload(token: string, buf = PNG, filename = 'photo.png', contentType = 'image/png') {
    return request(server)
      .post(`/consultations/${consultationId}/attachments`)
      .set('Authorization', bearer(token))
      .attach('file', buf, { filename, contentType });
  }

  it('a participant uploads a valid PNG and it is audited (no filename in metadata)', async () => {
    const res = await upload(patientToken).expect(201);
    expect(res.body).toMatchObject({ mimeType: 'image/png', filename: 'photo.png' });

    const audit = await prisma.auditLog.findMany({
      where: { eventType: AUDIT_EVENTS.ATTACHMENT_UPLOADED },
    });
    expect(audit).toHaveLength(1);
    const meta = audit[0].metadata as Record<string, unknown>;
    expect(meta).toMatchObject({ mimeType: 'image/png' });
    expect(JSON.stringify(meta)).not.toContain('photo.png');
  });

  it('rejects a disallowed content type with 415', () =>
    upload(patientToken, Buffer.from('hello world'), 'notes.txt', 'text/plain').expect(415));

  it('rejects a spoofed content type (bytes are PNG but declared as JPEG) with 415', () =>
    upload(patientToken, PNG, 'photo.jpg', 'image/jpeg').expect(415));

  it('refuses upload from a non-participant patient (403)', () =>
    upload(otherPatientToken).expect(403));

  it('round-trips a download through a short-lived signed URL', async () => {
    await upload(patientToken).expect(201);

    const list = await request(server)
      .get(`/consultations/${consultationId}/attachments`)
      .set('Authorization', bearer(patientToken))
      .expect(200);
    expect(list.body).toHaveLength(1);
    const { downloadUrl, expiresAt } = list.body[0];
    expect(typeof downloadUrl).toBe('string');
    expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now());
    // No PII/clinical data in the signed URL (only an opaque token).
    expect(downloadUrl).not.toContain('photo.png');

    const dl = await request(server).get(downloadUrl).buffer(true).expect(200);
    expect(dl.headers['content-type']).toContain('image/png');
    expect(dl.headers['content-length']).toBe(String(PNG.length));
    expect(dl.headers['cache-control']).toContain('no-store');

    // The download itself is audited.
    const accessed = await prisma.auditLog.findMany({
      where: { eventType: AUDIT_EVENTS.ATTACHMENT_ACCESSED },
    });
    expect(accessed).toHaveLength(1);
  });

  it('refuses a download with a tampered token (403)', async () => {
    await upload(patientToken).expect(201);
    const list = await request(server)
      .get(`/consultations/${consultationId}/attachments`)
      .set('Authorization', bearer(patientToken))
      .expect(200);
    const url: string = list.body[0].downloadUrl;
    const tampered = url.slice(0, -2) + (url.endsWith('aa') ? 'bb' : 'aa');
    await request(server).get(tampered).expect(403);
  });

  it('refuses a download when the token is missing entirely (403)', async () => {
    await upload(patientToken).expect(201);
    const attachment = await prisma.attachment.findFirstOrThrow();
    await request(server).get(`/attachments/${attachment.id}/download`).expect(403);
  });

  it('refuses a valid token used against a different attachment id (403)', async () => {
    await upload(patientToken, PNG, 'a.png').expect(201);
    await upload(patientToken, PNG, 'b.png').expect(201);
    const list = await request(server)
      .get(`/consultations/${consultationId}/attachments`)
      .set('Authorization', bearer(patientToken))
      .expect(200);
    const [a, b] = list.body;
    // Token minted for attachment A, used on attachment B's route → mismatch → 403.
    const tokenForA = a.downloadUrl.split('token=')[1];
    await request(server).get(`/attachments/${b.id}/download?token=${tokenForA}`).expect(403);
  });

  it('refuses upload once the session has ended (not IN_SESSION) with 409', async () => {
    await request(server)
      .post(`/consultations/${consultationId}/complete`)
      .set('Authorization', bearer(nurseToken))
      .expect(200);
    await upload(patientToken).expect(409);
  });

  // ── Removing a file shared by mistake (ADR-0028) ───────────────────────────

  function remove(token: string, attachmentId: string) {
    return request(server)
      .delete(`/consultations/${consultationId}/attachments/${attachmentId}`)
      .set('Authorization', bearer(token));
  }

  it('the patient removes their own file during the session; it is gone and audited', async () => {
    const { body: uploaded } = await upload(patientToken).expect(201);
    await remove(patientToken, uploaded.id).expect(204);

    const list = await request(server)
      .get(`/consultations/${consultationId}/attachments`)
      .set('Authorization', bearer(nurseToken))
      .expect(200);
    expect(list.body).toHaveLength(0);

    const audit = await prisma.auditLog.findFirst({
      where: { consultationId, eventType: AUDIT_EVENTS.ATTACHMENT_DELETED },
    });
    expect(audit?.metadata).toMatchObject({ attachmentId: uploaded.id });
    // Who/what/when only — never the filename.
    expect(JSON.stringify(audit?.metadata ?? {})).not.toContain('photo.png');
  });

  it("a clinician cannot remove files, and a patient cannot remove the clinician's (403)", async () => {
    const { body: patientFile } = await upload(patientToken).expect(201);
    const { body: nurseFile } = await upload(nurseToken, PNG, 'nurse.png').expect(201);
    await remove(nurseToken, patientFile.id).expect(403);
    await remove(nurseToken, nurseFile.id).expect(403);
    await remove(patientToken, nurseFile.id).expect(403);
    await remove(otherPatientToken, patientFile.id).expect(403);
  });

  it('refuses removal once the session has ended (409) — the file stays on the record', async () => {
    const { body: uploaded } = await upload(patientToken).expect(201);
    await request(server)
      .post(`/consultations/${consultationId}/complete`)
      .set('Authorization', bearer(nurseToken))
      .expect(200);
    await remove(patientToken, uploaded.id).expect(409);
    const list = await request(server)
      .get(`/consultations/${consultationId}/attachments`)
      .set('Authorization', bearer(patientToken))
      .expect(200);
    expect(list.body).toHaveLength(1);
  });
});
