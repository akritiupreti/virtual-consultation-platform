import { ConfigService } from '@nestjs/config';
import { SignedUrlService } from '../src/attachments/signed-url.service';

/**
 * Unit tests for the attachment signed-URL tokens (ADR-0007). They must be
 * tamper-evident, bound to a specific attachment + user, and expire — proven here
 * deterministically with a mocked clock rather than a slow timeout in e2e.
 */
function makeService(ttlSeconds = 300): SignedUrlService {
  const config = {
    get: (key: string) =>
      ({
        ATTACHMENT_URL_SECRET: 'unit-test-secret',
        ATTACHMENT_URL_TTL_SECONDS: String(ttlSeconds),
      })[key],
  } as unknown as ConfigService;
  return new SignedUrlService(config);
}

describe('SignedUrlService', () => {
  afterEach(() => jest.restoreAllMocks());

  it('round-trips valid claims', () => {
    const svc = makeService();
    const { token } = svc.sign('att-1', 'user-1');
    expect(svc.verify(token)).toMatchObject({ attachmentId: 'att-1', userId: 'user-1' });
  });

  it('rejects a tampered token', () => {
    const svc = makeService();
    const { token } = svc.sign('att-1', 'user-1');
    const tampered = token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a');
    expect(svc.verify(tampered)).toBeNull();
  });

  it('rejects a malformed token', () => {
    const svc = makeService();
    expect(svc.verify('not-a-token')).toBeNull();
    expect(svc.verify('')).toBeNull();
  });

  it('rejects an expired token', () => {
    const svc = makeService(60);
    const { token } = svc.sign('att-1', 'user-1');
    // Advance the clock past the TTL.
    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000);
    expect(svc.verify(token)).toBeNull();
  });

  it('is unforgeable without the secret (different secret → reject)', () => {
    const minter = makeService();
    const { token } = minter.sign('att-1', 'user-1');
    const other = new SignedUrlService({
      get: (key: string) =>
        ({ ATTACHMENT_URL_SECRET: 'a-different-secret', ATTACHMENT_URL_TTL_SECONDS: '300' })[key],
    } as unknown as ConfigService);
    expect(other.verify(token)).toBeNull();
  });
});
