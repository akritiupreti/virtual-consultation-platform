import { Inject, Injectable } from '@nestjs/common';
import { HealthIndicator, HealthIndicatorResult } from '@nestjs/terminus';
import { OptionalRedis, REDIS_CLIENT } from '../realtime/redis.provider';

/**
 * Readiness indicator for Redis — deliberately **non-gating** (ADR-0004: Redis is
 * ephemeral, never a source of truth; the app must degrade gracefully, not fall
 * over, when it is absent). It reports the real state but never throws, so a Redis
 * outage shows as `degraded` in the payload while `/ready` stays 200:
 *
 * - no `REDIS_URL` configured → `disabled` (single-instance in-memory mode);
 * - configured and reachable → `up`;
 * - configured but unreachable → `down` + `degraded` (core flows still work).
 */
@Injectable()
export class RedisHealthIndicator extends HealthIndicator {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: OptionalRedis) {
    super();
  }

  async check(key: string): Promise<HealthIndicatorResult> {
    if (!this.redis) {
      return this.getStatus(key, true, { mode: 'disabled' });
    }
    try {
      const pong = await this.withTimeout(this.redis.ping(), 1000);
      return this.getStatus(key, pong === 'PONG', { mode: 'connected' });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unreachable';
      // Resolve (do not throw): a degraded cache must not make the node unready.
      return this.getStatus(key, false, { mode: 'degraded', message });
    }
  }

  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms).unref(),
      ),
    ]);
  }
}
