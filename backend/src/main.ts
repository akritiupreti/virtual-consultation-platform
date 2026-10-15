import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { json, urlencoded } from 'express';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { RedisIoAdapter } from './realtime/redis-io.adapter';

async function bootstrap(): Promise<void> {
  // Disable the default body parser so we can impose explicit size caps below.
  const app = await NestFactory.create(AppModule, { bodyParser: false });

  app.use(helmet());

  // Cap JSON/urlencoded payloads (input-validation hardening, NFR-1). File uploads
  // are multipart and handled by multer in the AttachmentsModule with their own
  // size limit, so they are unaffected by this JSON cap.
  const bodyLimit = process.env.JSON_BODY_LIMIT ?? '100kb';
  app.use(json({ limit: bodyLimit }));
  app.use(urlencoded({ extended: true, limit: bodyLimit }));
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
