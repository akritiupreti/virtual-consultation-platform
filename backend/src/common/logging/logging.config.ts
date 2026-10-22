import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Params } from 'nestjs-pino';
import { DEFAULT_CORRELATION_HEADER } from '../correlation/correlation.middleware';

// `id` is already declared on IncomingMessage by pino-http's type augmentation;
// we only add the correlation field the middleware stashes.
interface RequestWithCorrelation extends IncomingMessage {
  correlationId?: string;
}

/** Strip the query string — it can carry PII/clinical identifiers (NFR-2). */
function pathOnly(url?: string): string | undefined {
  if (!url) {
    return url;
  }
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}

/**
 * Pino configuration for structured JSON logging (ADR-0013). The log record is
 * strictly who/what/when: method, path (no query), status, correlation ID,
 * timing. It NEVER emits request/response bodies or headers — those can carry
 * `Authorization` tokens, cookies, or clinical content — so the Phase 4 privacy
 * boundary (NFR-2, invariant 6) holds in the logs too (SC-9). Request-completion
 * logs for the probe/metrics endpoints are suppressed to keep the signal clean.
 */
export function buildLoggerParams(): Params {
  const isProd = process.env.NODE_ENV === 'production';
  const pretty = process.env.LOG_PRETTY ? process.env.LOG_PRETTY === 'true' : !isProd;
  const headerName = (
    process.env.CORRELATION_ID_HEADER ?? DEFAULT_CORRELATION_HEADER
  ).toLowerCase();
  const quiet = new Set(['/health', '/ready', '/metrics']);

  return {
    pinoHttp: {
      level: process.env.LOG_LEVEL ?? (isProd ? 'info' : 'debug'),
      // Reuse the ID the correlation middleware assigned (it ran first); fall back
      // to a fresh UUID so no log line is ever without a correlation ID.
      genReqId: (req: RequestWithCorrelation, res: ServerResponse): string => {
        const id = req.correlationId ?? randomUUID();
        if (!res.getHeader(headerName)) {
          res.setHeader(headerName, id);
        }
        return id;
      },
      customProps: (req: RequestWithCorrelation) => ({
        correlationId: req.correlationId ?? req.id,
      }),
      // Minimal serializers = the privacy guard: only who/what/when leaves here.
      serializers: {
        req(req: RequestWithCorrelation) {
          return { id: req.id, method: req.method, url: pathOnly(req.url) };
        },
        res(res: { statusCode?: number }) {
          return { statusCode: res.statusCode };
        },
      },
      // Defence in depth in case a future serializer change lets objects through.
      redact: {
        paths: ['req.headers', 'req.body', 'res.headers', 'req.query', 'req.params'],
        remove: true,
      },
      autoLogging: {
        ignore: (req: RequestWithCorrelation & { url?: string }) =>
          quiet.has(pathOnly(req.url) ?? ''),
      },
      transport: pretty
        ? { target: 'pino-pretty', options: { singleLine: true, translateTime: 'SYS:standard' } }
        : undefined,
    },
  };
}
