import { Logger, Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

/**
 * DI token for the shared Redis client used by presence and the queue-position
 * cache. The value is `Redis | null`: `null` means no `REDIS_URL` was configured,
 * so those features run in single-instance in-memory / DB-only mode (ADR-0004
 * consequence: degrade real-time, keep core flows). Redis is never a source of
 * truth — PostgreSQL is (ADR-0002/0004).
 */
export const REDIS_CLIENT = 'REDIS_CLIENT';

export type OptionalRedis = Redis | null;

export const redisClientProvider: Provider = {
  provide: REDIS_CLIENT,
  inject: [ConfigService],
  useFactory: (config: ConfigService): OptionalRedis => {
    const log = new Logger('Redis');
    const url = config.get<string>('REDIS_URL');
    if (!url) {
      log.warn(
        'REDIS_URL not set — presence and cross-instance fan-out disabled ' +
          '(single-instance in-memory mode).',
      );
      return null;
    }

    // Fail fast on individual commands so a Redis outage degrades rather than
    // hanging requests; stop reconnecting after a few attempts.
    const client = new Redis(url, {
      maxRetriesPerRequest: 2,
      retryStrategy: (times) => (times > 5 ? null : Math.min(times * 200, 2000)),
    });
    client.on('error', (err) => log.warn(`Redis error (degrading): ${err.message}`));
    client.on('connect', () => log.log(`Redis connected (${url})`));
    return client;
  },
};
