/**
 * Seed script — one test user per role (requirements FR-1 roles).
 * Idempotent: re-running upserts the same accounts.
 *
 * Run: npm run seed --workspace backend   (requires DATABASE_URL + migrations applied)
 */
import { PrismaClient, Role } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

const SEED_PASSWORD = process.env.SEED_PASSWORD ?? 'Password123!';

const seedUsers: Array<{ email: string; role: Role }> = [
  { email: 'patient@vcp.local', role: Role.PATIENT },
  { email: 'nurse@vcp.local', role: Role.NURSE },
  { email: 'doctor@vcp.local', role: Role.DOCTOR },
  { email: 'admin@vcp.local', role: Role.ADMIN },
];

async function main(): Promise<void> {
  const passwordHash = await bcrypt.hash(SEED_PASSWORD, 10);

  for (const u of seedUsers) {
    await prisma.user.upsert({
      where: { email: u.email },
      update: {},
      create: { email: u.email, passwordHash, role: u.role },
    });
    console.log(`seeded ${u.role.padEnd(7)} -> ${u.email}`);
  }

  console.log(`\nAll seed users share the password: ${SEED_PASSWORD}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
