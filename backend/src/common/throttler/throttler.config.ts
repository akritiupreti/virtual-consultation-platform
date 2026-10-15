import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import { ThrottlerModuleOptions } from '@nestjs/throttler';

/**
 * Rate-limit configuration (ADR-0011). App-level throttling protects the auth and
 * upload surfaces from brute-force and abuse. A single global throttler sets a
 * generous default; stricter per-route limits are applied via the decorators below,
 * which override the default throttler for that handler.
 *
 * Storage is the throttler's in-memory store by default; the documented scale-out
 * path is a Redis-backed store (ADR-0004 lists rate limiting as a Redis
 * responsibility), degrading to per-instance limits when Redis is absent — the same
 * stance as the socket adapter and presence.
 */
function intOr(raw: unknown, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/** In the test env, limits are raised far out of the way so the concurrency/e2e
 * suites (which fire many requests from one IP) never trip 429. */
const TEST_SCALE = process.env.NODE_ENV === 'test' ? 100_000 : 1;
const TTL_MS = intOr(process.env.THROTTLE_TTL_SECONDS, 60) * 1000;

export function buildThrottlerOptions(config: ConfigService): ThrottlerModuleOptions {
  const ttl = intOr(config.get('THROTTLE_TTL_SECONDS'), 60) * 1000;
  const limit = intOr(config.get('THROTTLE_LIMIT'), 100) * (TEST_SCALE > 1 ? TEST_SCALE : 1);
  return { throttlers: [{ name: 'default', ttl, limit }] };
}

/** Stricter limit for authentication endpoints (brute-force protection). */
export const AuthThrottle = (): MethodDecorator & ClassDecorator =>
  Throttle({
    default: { ttl: TTL_MS, limit: intOr(process.env.AUTH_THROTTLE_LIMIT, 10) * TEST_SCALE },
  });

/** Stricter limit for attachment uploads. */
export const UploadThrottle = (): MethodDecorator & ClassDecorator =>
  Throttle({
    default: { ttl: TTL_MS, limit: intOr(process.env.UPLOAD_THROTTLE_LIMIT, 30) * TEST_SCALE },
  });
