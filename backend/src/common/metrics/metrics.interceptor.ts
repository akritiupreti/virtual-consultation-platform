import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Observable } from 'rxjs';
import { finalize } from 'rxjs/operators';
import { MetricsService } from './metrics.service';

/**
 * Times every HTTP request and records it on {@link MetricsService}. It labels by
 * the matched **route template** (e.g. `/consultations/:id/claim`), never the
 * concrete path, so metric cardinality stays bounded and no ID ever lands in a
 * label. WebSocket and other non-HTTP contexts are skipped.
 */
@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  constructor(private readonly metrics: MetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') {
      return next.handle();
    }
    const http = context.switchToHttp();
    const req = http.getRequest<Request & { route?: { path?: string } }>();
    const res = http.getResponse<Response>();
    const method = req.method;
    const start = process.hrtime.bigint();

    return next.handle().pipe(
      finalize(() => {
        const route = req.route?.path ?? normalize(req.path);
        const seconds = Number(process.hrtime.bigint() - start) / 1e9;
        this.metrics.observeHttp(method, route, res.statusCode, seconds);
      }),
    );
  }
}

/** Fallback when no route matched (404s etc.): collapse to a single bucket so an
 * unrouted scan can't explode label cardinality. */
function normalize(path: string): string {
  return path === '/' ? '/' : 'unmatched';
}
