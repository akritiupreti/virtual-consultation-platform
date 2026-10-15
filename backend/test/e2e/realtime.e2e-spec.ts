import { INestApplication } from '@nestjs/common';
import { Priority, Role } from '@prisma/client';
import { Socket } from 'socket.io-client';
import { ConsultationsService } from '../../src/consultations/consultations.service';
import { MessagingService } from '../../src/messaging/messaging.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import {
  connectSocket,
  createListeningTestApp,
  createUser,
  login,
  resetDb,
  waitForConnect,
  waitForDisconnect,
  waitForEvent,
} from './helpers';

/**
 * CS-7 (live updates) and CS-9 (WS auth/authz boundaries), ADR-0005/0009.
 *
 * Proves two things over real socket.io connections to a listening app:
 *  1. Two subscribers see live queue/room updates (the Phase 3 exit criterion).
 *  2. Authorization holds over WebSockets exactly as over REST — the handshake is
 *     authenticated, and admins / non-participants cannot join clinical rooms
 *     (separation of duties, invariants 3 & 4).
 */
describe('real-time gateway (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let url: string;
  let consultations: ConsultationsService;
  let messaging: MessagingService;
  const sockets: Socket[] = [];

  beforeAll(async () => {
    ({ app, prisma, url } = await createListeningTestApp());
    consultations = app.get(ConsultationsService);
    messaging = app.get(MessagingService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDb(prisma);
  });

  afterEach(() => {
    while (sockets.length) {
      sockets.pop()?.disconnect();
    }
  });

  /** Connect, track for cleanup, and wait until the handshake completes. */
  async function connected(token?: string): Promise<Socket> {
    const socket = connectSocket(url, token);
    sockets.push(socket);
    await waitForConnect(socket);
    return socket;
  }

  async function seedQueuedRequest(
    email: string,
    priority: Priority = Priority.ROUTINE,
  ): Promise<string> {
    const patient = await createUser(prisma, Role.PATIENT, email);
    const view = await consultations.submitRequest(
      { id: patient.id, role: Role.PATIENT },
      {
        chiefComplaint: 'Headache',
        symptomCategory: 'NEUROLOGICAL',
        onsetDuration: '1 day',
        severity: 2,
        consent: true,
        priority,
      },
    );
    return view.id;
  }

  // ── Authentication ──────────────────────────────────────────────────────────

  it('rejects an unauthenticated connection', async () => {
    const socket = connectSocket(url); // no token
    sockets.push(socket);
    await waitForDisconnect(socket);
    expect(socket.connected).toBe(false);
  });

  it('accepts a connection with a valid token', async () => {
    await createUser(prisma, Role.NURSE, 'nurse@test.local');
    const token = await login(app, 'nurse@test.local');
    const socket = await connected(token);
    expect(socket.connected).toBe(true);
  });

  // ── Authorization over WebSockets (CS-9) ─────────────────────────────────────

  it('lets a clinician subscribe to the queue but refuses a patient and an admin', async () => {
    await createUser(prisma, Role.NURSE, 'nurse@test.local');
    await createUser(prisma, Role.PATIENT, 'patient@test.local');
    await createUser(prisma, Role.ADMIN, 'admin@test.local');

    const nurse = await connected(await login(app, 'nurse@test.local'));
    const patient = await connected(await login(app, 'patient@test.local'));
    const admin = await connected(await login(app, 'admin@test.local'));

    await expect(nurse.emitWithAck('subscribe:queue')).resolves.toEqual({ ok: true });
    await expect(patient.emitWithAck('subscribe:queue')).resolves.toMatchObject({ ok: false });
    await expect(admin.emitWithAck('subscribe:queue')).resolves.toMatchObject({ ok: false });
  });

  it('refuses an admin and a non-participant clinician from joining a consultation room', async () => {
    const consultationId = await seedQueuedRequest('patient@test.local');
    const nurse = await createUser(prisma, Role.NURSE, 'nurse@test.local');
    await consultations.claim({ id: nurse.id, role: Role.NURSE }, consultationId); // assigns nurse
    await createUser(prisma, Role.NURSE, 'other-nurse@test.local');
    await createUser(prisma, Role.ADMIN, 'admin@test.local');

    const otherNurse = await connected(await login(app, 'other-nurse@test.local'));
    const admin = await connected(await login(app, 'admin@test.local'));

    await expect(
      otherNurse.emitWithAck('join:consultation', { consultationId }),
    ).resolves.toMatchObject({ ok: false, error: 'forbidden' });
    await expect(admin.emitWithAck('join:consultation', { consultationId })).resolves.toMatchObject(
      {
        ok: false,
        error: 'forbidden',
      },
    );
  });

  // ── Live updates (CS-7) ──────────────────────────────────────────────────────

  it('pushes a queue update to two subscribed clinicians when a request is enqueued', async () => {
    await createUser(prisma, Role.NURSE, 'nurse1@test.local');
    await createUser(prisma, Role.DOCTOR, 'doctor1@test.local');
    const nurse = await connected(await login(app, 'nurse1@test.local'));
    const doctor = await connected(await login(app, 'doctor1@test.local'));

    expect(await nurse.emitWithAck('subscribe:queue')).toEqual({ ok: true });
    expect(await doctor.emitWithAck('subscribe:queue')).toEqual({ ok: true });

    const nurseEvent = waitForEvent<{ reason: string }>(nurse, 'queue:updated');
    const doctorEvent = waitForEvent<{ reason: string }>(doctor, 'queue:updated');

    await seedQueuedRequest('patient@test.local'); // triggers the fan-out

    const [n, d] = await Promise.all([nurseEvent, doctorEvent]);
    expect(n.reason).toBe('enqueued');
    expect(d.reason).toBe('enqueued');
  });

  it('pushes the patient their live "N ahead" position', async () => {
    const patient = await createUser(prisma, Role.PATIENT, 'patient@test.local');
    const patientSocket = await connected(await login(app, 'patient@test.local'));

    // First request: this patient is at the front (0 ahead).
    const first = waitForEvent<{ position: number | null }>(patientSocket, 'position:updated');
    const myId = await consultations
      .submitRequest(
        { id: patient.id, role: Role.PATIENT },
        {
          chiefComplaint: 'Sore throat',
          symptomCategory: 'GENERAL',
          onsetDuration: '2 days',
          severity: 2,
          consent: true,
          priority: Priority.ROUTINE,
        },
      )
      .then((v) => v.id);
    const firstUpdate = await first;
    expect(firstUpdate).toMatchObject({ consultationId: myId, position: 0 });

    // A higher-priority request arrives: this patient is now 1 ahead.
    const second = waitForEvent<{ position: number | null }>(patientSocket, 'position:updated');
    await seedQueuedRequest('urgent@test.local', Priority.EMERGENCY);
    const secondUpdate = await second;
    expect(secondUpdate).toMatchObject({ consultationId: myId, position: 1 });
  });

  it('delivers a new message live to the other participant in the room', async () => {
    const consultationId = await seedQueuedRequest('patient@test.local');
    const nurse = await createUser(prisma, Role.NURSE, 'nurse@test.local');
    await consultations.claim({ id: nurse.id, role: Role.NURSE }, consultationId);
    await consultations.start({ id: nurse.id, role: Role.NURSE }, consultationId); // → IN_SESSION

    const patientSocket = await connected(await login(app, 'patient@test.local'));
    const nurseSocket = await connected(await login(app, 'nurse@test.local'));
    await patientSocket.emitWithAck('join:consultation', { consultationId });
    await nurseSocket.emitWithAck('join:consultation', { consultationId });

    const received = waitForEvent<{ message: { body: string } }>(patientSocket, 'message:created');
    await messaging.send({ id: nurse.id, role: Role.NURSE }, consultationId, {
      body: 'How are you feeling now?',
    });

    const event = await received;
    expect(event.message.body).toBe('How are you feeling now?');
  });
});
