import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { CorrelationService } from './correlation.service';

/** Default header name; overridable with CORRELATION_ID_HEADER. */
export const DEFAULT_CORRELATION_HEADER = 'x-correlation-id';

/** Upper bound + charset for an accepted inbound ID — rejects anything that could
 * be a header/log-injection vector or smuggle PII through the trace token. */
const MAX_ID_LENGTH = 128;
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

export interface CorrelationRequest extends Request {
  correlationId?: string;
}

function isAcceptable(value: string | undefined): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_ID_LENGTH &&
    SAFE_ID.test(value)
  );
}

/**
 * Express middleware that establishes the correlation ID for a request: it reuses
 * a caller-supplied, well-formed ID (so a trace can span services) or mints a UUID,
 * echoes it on the response header (SC-15 — a request is traceable end-to-end), and
 * runs the rest of the request inside the {@link CorrelationService} store so the
 * domain services and audit layer can read it. Registered before the framework
 * middleware in `main.ts`, so the ID exists for every downstream log line.
 */
export function createCorrelationMiddleware(
  service: CorrelationService,
  headerName: string = DEFAULT_CORRELATION_HEADER,
) {
  const header = headerName.toLowerCase();
  return (req: CorrelationRequest, res: Response, next: NextFunction): void => {
    const raw = req.headers[header];
    const candidate = Array.isArray(raw) ? raw[0] : raw;
    const correlationId = isAcceptable(candidate) ? candidate : randomUUID();
    req.correlationId = correlationId;
    res.setHeader(headerName, correlationId);
    service.run(correlationId, () => next());
  };
}
