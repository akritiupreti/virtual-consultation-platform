import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Role } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/prisma/prisma.service';

export const TEST_PASSWORD = 'Password123!';

export interface TestContext {
  app: INestApplication;
  prisma: PrismaService;
}

/**
 * Safety net: e2e tests TRUNCATE every table, so refuse to run unless the target
 * database name clearly marks it as a throwaway test DB. This prevents a
 * misconfigured DATABASE_URL from wiping a developer's dev data.
 */
export function assertTestDatabase(): void {
  const url = process.env.DATABASE_URL ?? '';
  if (!/test/i.test(url)) {
    throw new Error(
      'Refusing to run e2e tests: DATABASE_URL must point at a database whose name ' +
        'contains "test" (e.g. vcp_test). See docs/testing-strategy.md.',
    );
  }
}

export async function createTestApp(): Promise<TestContext> {
  assertTestDatabase();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  await app.init();
  const prisma = app.get(PrismaService);
  return { app, prisma };
}

/** Delete all rows in FK-safe order between tests. */
export async function resetDb(prisma: PrismaService): Promise<void> {
  await prisma.auditLog.deleteMany();
  await prisma.addendum.deleteMany();
  await prisma.summary.deleteMany();
  await prisma.attachment.deleteMany();
  await prisma.message.deleteMany();
  await prisma.intake.deleteMany();
  await prisma.consultation.deleteMany();
  await prisma.user.deleteMany();
}

export async function createUser(
  prisma: PrismaService,
  role: Role,
  email: string,
): Promise<{ id: string; email: string }> {
  const passwordHash = await bcrypt.hash(TEST_PASSWORD, 4);
  const user = await prisma.user.create({ data: { email, passwordHash, role } });
  return { id: user.id, email: user.email };
}

/** Log in via the real auth endpoint and return a bearer token. */
export async function login(app: INestApplication, email: string): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ email, password: TEST_PASSWORD });
  if (res.status !== 200) {
    throw new Error(`login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.accessToken as string;
}
