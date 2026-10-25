/**
 * Seed script — demo accounts and sample data for local testing.
 *
 * Creates:
 *   - the four canonical role logins (patient@ / nurse@ / doctor@ / admin@vcp.local)
 *   - a roster of extra dummy patients, nurses, and doctors
 *   - a handful of sample consultations across the lifecycle (so the triage queue
 *     and the admin audit log have real content on a fresh database)
 *
 * Idempotent: every row uses a deterministic key (email for users, fixed UUIDs for
 * consultations / intakes / audit rows) and is upserted, so re-running is safe and
 * never duplicates. No real clinical data — all strings are obvious placeholders
 * (invariant 6).
 *
 * Run: npm run seed --workspace backend   (requires DATABASE_URL + migrations applied)
 */
import { ConsultationState, PrismaClient, Priority, Role, UserStatus } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

const SEED_PASSWORD = process.env.SEED_PASSWORD ?? 'Password123!';

interface SeedUser {
  email: string;
  role: Role;
  status?: UserStatus;
}

/** Canonical one-per-role logins referenced throughout the docs. */
const canonicalUsers: SeedUser[] = [
  { email: 'patient@vcp.local', role: Role.PATIENT },
  { email: 'nurse@vcp.local', role: Role.NURSE },
  { email: 'doctor@vcp.local', role: Role.DOCTOR },
  { email: 'admin@vcp.local', role: Role.ADMIN },
];

/** Extra dummy accounts for testing lists, queues, and reassignment. */
const dummyUsers: SeedUser[] = [
  // Patients
  { email: 'alice.patient@vcp.local', role: Role.PATIENT },
  { email: 'ben.patient@vcp.local', role: Role.PATIENT },
  { email: 'chloe.patient@vcp.local', role: Role.PATIENT },
  { email: 'dev.patient@vcp.local', role: Role.PATIENT },
  { email: 'emma.patient@vcp.local', role: Role.PATIENT },
  { email: 'frank.patient@vcp.local', role: Role.PATIENT },
  // Nurses
  { email: 'nina.nurse@vcp.local', role: Role.NURSE },
  { email: 'noah.nurse@vcp.local', role: Role.NURSE },
  { email: 'nora.nurse@vcp.local', role: Role.NURSE, status: UserStatus.DEACTIVATED },
  // Doctors
  { email: 'dana.doctor@vcp.local', role: Role.DOCTOR },
  { email: 'omar.doctor@vcp.local', role: Role.DOCTOR },
  { email: 'priya.doctor@vcp.local', role: Role.DOCTOR },
];

/**
 * Sample consultations. `id`s are fixed so the upsert is idempotent. Each is tied
 * to a dummy patient by email and, where relevant, a clinician by email. States
 * span the queue and in-session views so every screen has something to show.
 */
interface DemoConsultation {
  id: string;
  patientEmail: string;
  clinicianEmail?: string;
  state: ConsultationState;
  priority: Priority;
  minutesAgo: number;
  intake: {
    chiefComplaint: string;
    symptomCategory: string;
    onsetDuration: string;
    severity: number;
    history?: string;
    medications?: string;
  };
}

const demoConsultations: DemoConsultation[] = [
  {
    id: '11111111-1111-4111-8111-111111111101',
    patientEmail: 'alice.patient@vcp.local',
    state: ConsultationState.QUEUED,
    priority: Priority.EMERGENCY,
    minutesAgo: 12,
    intake: {
      chiefComplaint: 'Sudden shortness of breath (demo)',
      symptomCategory: 'RESPIRATORY',
      onsetDuration: '1 hour',
      severity: 5,
      history: 'Mild asthma (demo history)',
    },
  },
  {
    id: '11111111-1111-4111-8111-111111111102',
    patientEmail: 'ben.patient@vcp.local',
    state: ConsultationState.QUEUED,
    priority: Priority.URGENT,
    minutesAgo: 9,
    intake: {
      chiefComplaint: 'Chest tightness after exercise (demo)',
      symptomCategory: 'CARDIAC',
      onsetDuration: '3 hours',
      severity: 4,
    },
  },
  {
    id: '11111111-1111-4111-8111-111111111103',
    patientEmail: 'chloe.patient@vcp.local',
    state: ConsultationState.QUEUED,
    priority: Priority.ROUTINE,
    minutesAgo: 6,
    intake: {
      chiefComplaint: 'Itchy rash on forearm (demo)',
      symptomCategory: 'DERMATOLOGY',
      onsetDuration: '2 days',
      severity: 2,
    },
  },
  {
    id: '11111111-1111-4111-8111-111111111104',
    patientEmail: 'dev.patient@vcp.local',
    state: ConsultationState.QUEUED,
    priority: Priority.ROUTINE,
    minutesAgo: 3,
    intake: {
      chiefComplaint: 'Persistent headache (demo)',
      symptomCategory: 'NEUROLOGICAL',
      onsetDuration: '4 days',
      severity: 3,
      medications: 'Paracetamol as needed (demo)',
    },
  },
  {
    id: '11111111-1111-4111-8111-111111111105',
    patientEmail: 'emma.patient@vcp.local',
    clinicianEmail: 'doctor@vcp.local',
    state: ConsultationState.IN_SESSION,
    priority: Priority.URGENT,
    minutesAgo: 20,
    intake: {
      chiefComplaint: 'Abdominal pain, lower right (demo)',
      symptomCategory: 'GASTROINTESTINAL',
      onsetDuration: '1 day',
      severity: 4,
    },
  },
  {
    id: '11111111-1111-4111-8111-111111111106',
    patientEmail: 'frank.patient@vcp.local',
    clinicianEmail: 'nurse@vcp.local',
    state: ConsultationState.CLAIMED,
    priority: Priority.ROUTINE,
    minutesAgo: 15,
    intake: {
      chiefComplaint: 'Sore throat and mild fever (demo)',
      symptomCategory: 'GENERAL',
      onsetDuration: '2 days',
      severity: 2,
    },
  },
];

function minutesAgo(n: number): Date {
  return new Date(Date.now() - n * 60_000);
}

async function main(): Promise<void> {
  const passwordHash = await bcrypt.hash(SEED_PASSWORD, 10);
  const byEmail = new Map<string, string>();

  // 1) Users (canonical + dummy) — upsert by unique email.
  for (const u of [...canonicalUsers, ...dummyUsers]) {
    const status = u.status ?? UserStatus.ACTIVE;
    const user = await prisma.user.upsert({
      where: { email: u.email },
      update: { role: u.role, status },
      create: { email: u.email, passwordHash, role: u.role, status },
    });
    byEmail.set(u.email, user.id);
    console.log(`seeded ${u.role.padEnd(7)} ${status.padEnd(11)} -> ${u.email}`);
  }

  // 2) Sample consultations + intake — upsert by fixed id (idempotent).
  for (const c of demoConsultations) {
    const patientId = byEmail.get(c.patientEmail);
    if (!patientId) {
      continue;
    }
    const clinicianId = c.clinicianEmail ? (byEmail.get(c.clinicianEmail) ?? null) : null;
    const createdAt = minutesAgo(c.minutesAgo);
    const enqueuedAt = minutesAgo(c.minutesAgo - 1);
    const claimedAt =
      c.state === ConsultationState.CLAIMED || c.state === ConsultationState.IN_SESSION
        ? minutesAgo(c.minutesAgo - 2)
        : null;
    const startedAt =
      c.state === ConsultationState.IN_SESSION ? minutesAgo(c.minutesAgo - 3) : null;

    await prisma.consultation.upsert({
      where: { id: c.id },
      update: {
        patientId,
        claimedBy: clinicianId,
        state: c.state,
        priority: c.priority,
        enqueuedAt,
        claimedAt,
        startedAt,
      },
      create: {
        id: c.id,
        patientId,
        claimedBy: clinicianId,
        state: c.state,
        priority: c.priority,
        createdAt,
        enqueuedAt,
        claimedAt,
        startedAt,
      },
    });

    await prisma.intake.upsert({
      where: { consultationId: c.id },
      update: {
        chiefComplaint: c.intake.chiefComplaint,
        symptomCategory: c.intake.symptomCategory,
        onsetDuration: c.intake.onsetDuration,
        severity: c.intake.severity,
        history: c.intake.history ?? null,
        medications: c.intake.medications ?? null,
      },
      create: {
        consultationId: c.id,
        chiefComplaint: c.intake.chiefComplaint,
        symptomCategory: c.intake.symptomCategory,
        onsetDuration: c.intake.onsetDuration,
        severity: c.intake.severity,
        consentAt: createdAt,
        history: c.intake.history ?? null,
        medications: c.intake.medications ?? null,
      },
    });
  }

  // 3) Audit log — who/what/when only, no clinical content (invariants 3 & 5).
  //    Fixed ids keep this idempotent so the admin audit view has sample rows.
  const auditRows = [
    { suffix: '01', actor: 'admin@vcp.local', event: 'LOGIN_SUCCESS', consultation: null, min: 25 },
    {
      suffix: '02',
      actor: 'alice.patient@vcp.local',
      event: 'CONSULTATION_REQUESTED',
      consultation: '11111111-1111-4111-8111-111111111101',
      min: 13,
    },
    {
      suffix: '03',
      actor: 'alice.patient@vcp.local',
      event: 'CONSULTATION_ENQUEUED',
      consultation: '11111111-1111-4111-8111-111111111101',
      min: 12,
    },
    {
      suffix: '04',
      actor: 'doctor@vcp.local',
      event: 'CONSULTATION_CLAIMED',
      consultation: '11111111-1111-4111-8111-111111111105',
      min: 18,
    },
    {
      suffix: '05',
      actor: 'doctor@vcp.local',
      event: 'CONSULTATION_STARTED',
      consultation: '11111111-1111-4111-8111-111111111105',
      min: 17,
    },
    {
      suffix: '06',
      actor: 'nurse@vcp.local',
      event: 'CONSULTATION_CLAIMED',
      consultation: '11111111-1111-4111-8111-111111111106',
      min: 13,
    },
  ];
  for (const r of auditRows) {
    const id = `22222222-2222-4222-8222-0000000000${r.suffix}`;
    await prisma.auditLog.upsert({
      where: { id },
      update: {},
      create: {
        id,
        actorId: r.actor ? (byEmail.get(r.actor) ?? null) : null,
        eventType: r.event,
        consultationId: r.consultation,
        metadata: { seed: true },
        createdAt: minutesAgo(r.min),
      },
    });
  }

  console.log(
    `\nSeeded ${canonicalUsers.length + dummyUsers.length} users, ` +
      `${demoConsultations.length} consultations, ${auditRows.length} audit events.`,
  );
  console.log(`All seed users share the password: ${SEED_PASSWORD}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
