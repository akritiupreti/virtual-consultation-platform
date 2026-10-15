import { INestApplicationContext, Logger } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';
import type { Server, ServerOptions } from 'socket.io';

/**
 * socket.io adapter that fans events out across API instances via Redis pub/sub
 * (ADR-0004/0009). If Redis is unreachable it logs and falls back to the default
 * in-memory adapter, so a single instance still works fully (graceful
 * degradation). CORS for the handshake is applied here, where env is loaded.
 */
export class RedisIoAdapter extends IoAdapter {
  private readonly log = new Logger(RedisIoAdapter.name);
  private adapterConstructor?: ReturnType<typeof createAdapter>;

  constructor(
    app: INestApplicationContext,
    private readonly corsOrigins: string[],
  ) {
    super(app);
  }

  /** Returns true if the Redis adapter was wired, false if degraded to in-memory. */
  async connectToRedis(url: string): Promise<boolean> {
    const pubClient = new Redis(url, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
    });
    const subClient = pubClient.duplicate();
    pubClient.on('error', (err) => this.log.warn(`Redis pub error: ${err.message}`));
    subClient.on('error', (err) => this.log.warn(`Redis sub error: ${err.message}`));

    try {
      await Promise.all([pubClient.connect(), subClient.connect()]);
      this.adapterConstructor = createAdapter(pubClient, subClient);
      this.log.log('socket.io Redis adapter enabled (cross-instance fan-out).');
      return true;
    } catch (err) {
      this.log.warn(
        `Redis adapter unavailable (${(err as Error).message}); ` +
          'falling back to single-instance in-memory fan-out.',
      );
      pubClient.disconnect();
      subClient.disconnect();
      return false;
    }
  }

  createIOServer(port: number, options?: ServerOptions): Server {
    const server: Server = super.createIOServer(port, {
      ...options,
      cors: { origin: this.corsOrigins, credentials: true },
    });
    if (this.adapterConstructor) {
      server.adapter(this.adapterConstructor);
    }
    return server;
  }
}
