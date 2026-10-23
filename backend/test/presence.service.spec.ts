import { PresenceService } from '../src/realtime/presence.service';

/**
 * Unit coverage for presence across the two backends (ADR-0004): an in-memory
 * map when Redis is absent, the shared hash when present, and graceful
 * degradation ("assume offline", never throw) when Redis fails.
 */
describe('PresenceService (unit)', () => {
  describe('without Redis (single instance)', () => {
    it('counts connections up and down in memory', async () => {
      const svc = new PresenceService(null);
      await svc.markConnected('u');
      await svc.markConnected('u');
      expect(await svc.isOnline('u')).toBe(true);
      await svc.markDisconnected('u');
      expect(await svc.isOnline('u')).toBe(true);
      await svc.markDisconnected('u');
      expect(await svc.isOnline('u')).toBe(false);
    });

    it('onModuleDestroy is a no-op with no client', async () => {
      const svc = new PresenceService(null);
      await expect(svc.onModuleDestroy()).resolves.toBeUndefined();
    });
  });

  describe('with Redis', () => {
    it('uses the shared hash and clears a user at zero', async () => {
      const redis = {
        hincrby: jest.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(0),
        hdel: jest.fn().mockResolvedValue(1),
        hget: jest.fn().mockResolvedValue('1'),
        quit: jest.fn().mockResolvedValue('OK'),
        disconnect: jest.fn(),
      };
      const svc = new PresenceService(redis as never);
      await svc.markConnected('u');
      expect(redis.hincrby).toHaveBeenCalledWith('presence:connections', 'u', 1);
      await svc.markDisconnected('u');
      expect(redis.hdel).toHaveBeenCalled();
      expect(await svc.isOnline('u')).toBe(true);
      await svc.onModuleDestroy();
      expect(redis.quit).toHaveBeenCalled();
    });

    it('degrades to assume-offline when Redis throws', async () => {
      const redis = {
        hincrby: jest.fn().mockRejectedValue(new Error('down')),
        hdel: jest.fn(),
        hget: jest.fn().mockRejectedValue(new Error('down')),
        quit: jest.fn().mockRejectedValue(new Error('down')),
        disconnect: jest.fn(),
      };
      const svc = new PresenceService(redis as never);
      await expect(svc.markConnected('u')).resolves.toBeUndefined();
      await expect(svc.markDisconnected('u')).resolves.toBeUndefined();
      // hget throws → falls back to the in-memory count (0 → offline).
      expect(await svc.isOnline('u')).toBe(false);
      // quit throws → disconnect() is used as the fallback.
      await svc.onModuleDestroy();
      expect(redis.disconnect).toHaveBeenCalled();
    });
  });
});
