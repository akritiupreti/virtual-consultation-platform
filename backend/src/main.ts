import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { RedisIoAdapter } from './realtime/redis-io.adapter';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  app.use(helmet());
  // Allow the Vite dev frontend (configurable, comma-separated) to call the API.
  const corsOrigin = process.env.CORS_ORIGIN?.split(',').map((o) => o.trim()) ?? [
    'http://localhost:5173',
  ];
  app.enableCors({ origin: corsOrigin, credentials: true });

  // WebSocket transport (ADR-0005/0009). The Redis adapter fans events out across
  // API instances; if REDIS_URL is unset or unreachable it degrades to a
  // single-instance in-memory adapter and the app keeps working.
  const wsAdapter = new RedisIoAdapter(app, corsOrigin);
  const redisUrl = process.env.REDIS_URL;
  if (redisUrl) {
    await wsAdapter.connectToRedis(redisUrl);
  }
  app.useWebSocketAdapter(wsAdapter);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  const port = process.env.PORT ? Number(process.env.PORT) : 3000;
  await app.listen(port);
  console.log(`API listening on http://localhost:${port}`);
}

void bootstrap();
