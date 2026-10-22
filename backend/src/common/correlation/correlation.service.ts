import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';

/** Per-request (or per-WS-event, or per-sweep) trace context. */
export interface CorrelationStore {
  correlationId: string;
}

/**
 * Carries the correlation ID across the async call-graph of one request without
 * threading it through every function signature (SC-15 / NFR-5). REST requests
 * enter the store via the correlation middleware; the WebSocket gateway and the
 * claim-TTL sweeper enter it explicitly with {@link run}. The ID is a trace token
 * only — who/what/when — never PII or clinical data (NFR-2).
 */
@Injectable()
export class CorrelationService {
  private readonly als = new AsyncLocalStorage<CorrelationStore>();

  /** Run `fn` with `correlationId` available to everything it awaits. */
  run<T>(correlationId: string, fn: () => T): T {
    return this.als.run({ correlationId }, fn);
  }

  /** The correlation ID for the current async context, if any. */
  getId(): string | undefined {
    return this.als.getStore()?.correlationId;
  }
}
