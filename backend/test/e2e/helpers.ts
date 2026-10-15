import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Role } from '@prisma/client';
import { AddressInfo } from 'net';
import * as bcrypt from 'bcryptjs';
import { io, Socket } from 'socket.io-client';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/prisma/prisma.service';

export const TEST_PASSWORD = 'Password123!';

export interface TestContext {
  app: INestApplication;
  prisma: PrismaService;
}

export interface ListeningTestContext extends TestContext {
  /** Base URL of the listening HTTP + WebSocket server (for socket.io-client). */
  url: string;
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

/**
 * Boot the app AND listen on an ephemeral port, so socket.io clients can connect.
 * Uses the default in-memory socket.io adapter (no Redis), which is enough to prove
 * two subscribers see live updates on one instance; cross-instance fan-out (the
 * Redis adapter) is a separate manual check — see docs/testing-strategy.md.
 */
export async function createListeningTestApp(): Promise<ListeningTestContext> {
  const { app, prisma } = await createTestApp();
  await app.listen(0);
  const { port } = app.getHttpServer().address() as AddressInfo;
  return { app, prisma, url: `http://127.0.0.1:${port}` };
}

/** Open a socket.io connection (optionally authenticated) with no auto-reconnect. */
export function connectSocket(url: string, token?: string): Socket {
  return io(url, {
    auth: token ? { token } : {},
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
  });
}

export function waitForConnect(socket: Socket, timeoutMs = 4000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (socket.connected) {
      resolve();
      return;
    }
    const timer = setTimeout(() => reject(new Error('timed out waiting for connect')), timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once('connect_error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** Resolve with the first payload emitted on `event`, or reject on timeout. */
export function waitForEvent<T>(socket: Socket, event: string, timeoutMs = 4000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out waiting for "${event}"`)),
      timeoutMs,
    );
    socket.once(event, (data: T) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

/** Resolve once the socket is disconnected (server-initiated or connect error). */
export function waitForDisconnect(socket: Socket, timeoutMs = 4000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (socket.disconnected && !socket.connected) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      if (socket.connected) {
        reject(new Error('socket is still connected'));
      } else {
        resolve();
      }
    }, timeoutMs);
    const done = (): void => {
      clearTimeout(timer);
      resolve();
    };
    socket.once('disconnect', done);
    socket.once('connect_error', done);
  });
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
