import { buildLoggerParams } from '../src/common/logging/logging.config';

/**
 * The logging policy is a privacy control, not cosmetics (NFR-2 / SC-9, invariant
 * 6): logs are who/what/when only. This locks the policy down at the unit level so
 * a future config change can't quietly start leaking headers, bodies, query strings
 * or clinical content into the log stream.
 */
describe('Logging privacy policy (ADR-0013)', () => {
  const pinoHttp = buildLoggerParams().pinoHttp as Record<string, any>;

  it('request serializer emits only id, method and path — never headers or body', () => {
    const out = pinoHttp.serializers.req({
      id: 'corr-1',
      method: 'POST',
      url: '/consultations/123/messages',
      headers: { authorization: 'Bearer secret.jwt.token', cookie: 'session=abc' },
      body: { body: 'PRIVATE patient said the pain is sharp' },
    });
    expect(out).toEqual({ id: 'corr-1', method: 'POST', url: '/consultations/123/messages' });
    expect(JSON.stringify(out)).not.toContain('Bearer');
    expect(JSON.stringify(out)).not.toContain('pain');
  });

  it('strips the query string (it can carry PII / identifiers)', () => {
    const out = pinoHttp.serializers.req({
      id: 'corr-2',
      method: 'GET',
      url: '/audit?actorId=u-42&email=patient@example.com',
    });
    expect(out.url).toBe('/audit');
    expect(JSON.stringify(out)).not.toContain('patient@example.com');
  });

  it('response serializer emits only the status code', () => {
    const out = pinoHttp.serializers.res({ statusCode: 201, headers: { 'set-cookie': 'x=y' } });
    expect(out).toEqual({ statusCode: 201 });
  });

  it('removes sensitive objects via redaction as defence in depth', () => {
    expect(pinoHttp.redact).toMatchObject({ remove: true });
    for (const path of ['req.headers', 'req.body', 'res.headers', 'req.query', 'req.params']) {
      expect(pinoHttp.redact.paths).toContain(path);
    }
  });

  it('suppresses request logging for the probe/metrics endpoints', () => {
    const ignore = pinoHttp.autoLogging.ignore as (req: { url?: string }) => boolean;
    expect(ignore({ url: '/health' })).toBe(true);
    expect(ignore({ url: '/ready' })).toBe(true);
    expect(ignore({ url: '/metrics' })).toBe(true);
    expect(ignore({ url: '/consultations' })).toBe(false);
  });
});
