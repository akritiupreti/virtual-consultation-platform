import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { OptionalRedis, REDIS_CLIENT } from './redis.provider';

const PRESENCE_HASH = 'presence:connections';

/**
 * Tracks who is currently connected (ADR-0004 — presence). When Redis is
 * available the connection counts live in a shared hash so presence is correct
 * across API instances; otherwise an in-memory map is used (single instance).
 * A user is "online" while they hold at least one live socket (multiple tabs
 * count up/down). All reads/writes are best-effort — a Redis failure degrades to
 * "assume offline" and never breaks a connection.
 */
@Injectable()
export class PresenceService implements OnModuleDestroy {
  private readonly log = new Logger(PresenceService.name);
  private readonly local = new Map<string, number>();

  constructor(@Inject(REDIS_CLIENT) private readonly redis: OptionalRedis) {}

  /**
   * Close the shared Redis connection on shutdown so it does not keep the process
   * (or a Jest run) alive. This service owns the lifecycle of the injected client.
   */
  async onModuleDestroy(): Promise<void> {
    if (!this.redis) {
      return;
    }
    try {
      await this.redis.quit();
    } catch {
      this.redis.disconnect();
    }
  }

  async markConnected(userId: string): Promise<void> {
    this.local.set(userId, (this.local.get(userId) ?? 0) + 1);
    if (this.redis) {
      try {
        await this.redis.hincrby(PRESENCE_HASH, userId, 1);
      } catch (err) {
        this.log.warn(`presence markConnected degraded: ${(err as Error).message}`);
      }
    }
  }

  async markDisconnected(userId: string): Promise<void> {
    const next = (this.local.get(userId) ?? 1) - 1;
    if (next <= 0) {
      this.local.delete(userId);
    } else {
      this.local.set(userId, next);
    }
    if (this.redis) {
      try {
        const remaining = await this.redis.hincrby(PRESENCE_HASH, userId, -1);
        if (remaining <= 0) {
          await this.redis.hdel(PRESENCE_HASH, userId);
        }
      } catch (err) {
        this.log.warn(`presence markDisconnected degraded: ${(err as Error).message}`);
      }
    }
  }

  async isOnline(userId: string): Promise<boolean> {
    if (this.redis) {
      try {
        const count = await this.redis.hget(PRESENCE_HASH, userId);
        return count != null && Number(count) > 0;
      } catch (err) {
        this.log.warn(`presence isOnline degraded: ${(err as Error).message}`);
      }
    }
    return (this.local.get(userId) ?? 0) > 0;
  }
}
