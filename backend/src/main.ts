import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { json, urlencoded } from 'express';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import {
  createCorrelationMiddleware,
  DEFAULT_CORRELATION_HEADER,
} from './common/correlation/correlation.middleware';
import { CorrelationService } from './common/correlation/correlation.service';
import { CorsIoAdapter } from './realtime/cors-io.adapter';

async function bootstrap(): Promise<void> {
  // Disable the default body parser so we can impose explicit size caps below.
  // bufferLogs defers startup logs until the pino logger is installed below.
  const app = await NestFactory.create(AppModule, { bodyParser: false, bufferLogs: true });

  // Route all framework logging through pino (structured JSON, docs/observability.md).
  app.useLogger(app.get(Logger));

  // Correlation ID first of all (SC-15): it must run before the framework and the
  // request logger so every downstream log line and the response header carry it.
  const correlationHeader = process.env.CORRELATION_ID_HEADER ?? DEFAULT_CORRELATION_HEADER;
  app.use(createCorrelationMiddleware(app.get(CorrelationService), correlationHeader));

  app.use(helmet());

  // Cap JSON/urlencoded payloads (input-validation hardening, NFR-1).
  const bodyLimit = process.env.JSON_BODY_LIMIT ?? '100kb';
  app.use(json({ limit: bodyLimit }));
  app.use(urlencoded({ extended: true, limit: bodyLimit }));
  // Allow the Vite dev frontend (configurable, comma-separated) to call the API.
  const corsOrigin = process.env.CORS_ORIGIN?.split(',').map((o) => o.trim()) ?? [
    'http://localhost:5173',
  ];
  app.enableCors({ origin: corsOrigin, credentials: true });

  // WebSocket transport (ADR-0004): socket.io with the same CORS origins as
  // the REST API applied to the handshake.
  app.useWebSocketAdapter(new CorsIoAdapter(app, corsOrigin));

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
