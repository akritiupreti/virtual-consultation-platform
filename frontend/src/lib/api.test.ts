import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, getToken, setToken, setUnauthorizedHandler } from './api';

function jsonResponse(body: unknown, init: Partial<Response> = {}): Response {
  return {
    ok: (init.status ?? 200) < 400,
    status: init.status ?? 200,
    statusText: init.statusText ?? 'OK',
    json: async () => body,
  } as unknown as Response;
}

describe('api client', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('stores and clears the token in localStorage', () => {
    expect(getToken()).toBeNull();
    setToken('abc');
    expect(getToken()).toBe('abc');
    setToken(null);
    expect(getToken()).toBeNull();
  });

  it('POSTs login and returns the parsed body', async () => {
    const result = { accessToken: 't', user: { id: 'u', email: 'a@b.test', role: 'PATIENT' } };
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(jsonResponse(result));
    await expect(api.login('a@b.test', 'pw')).resolves.toEqual(result);
    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('http://localhost:3000/auth/login');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ email: 'a@b.test', password: 'pw' });
  });

  it('attaches the bearer token when present', async () => {
    setToken('secret-token');
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(jsonResponse([]));
    await api.getQueue();
    const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(init.headers.Authorization).toBe('Bearer secret-token');
  });

  it('throws ApiError with a joined message from an array body', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      jsonResponse(
        { message: ['too short', 'bad email'] },
        { status: 400, statusText: 'Bad Request' },
      ),
    );
    await expect(api.login('x', 'y')).rejects.toMatchObject({
      name: 'ApiError',
      status: 400,
      message: 'too short, bad email',
    });
  });

  it('falls back to statusText when the error body is not JSON', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Server Error',
      json: async () => {
        throw new Error('not json');
      },
    } as unknown as Response);
    await expect(api.getQueue()).rejects.toMatchObject({ status: 500, message: 'Server Error' });
  });

  it('returns undefined for a 204 response', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 204,
      statusText: 'No Content',
      json: async () => undefined,
    } as unknown as Response);
    await expect(api.cancel('c-1')).resolves.toBeUndefined();
  });

  it('getAudit passes filters as a query string and drops empty ones', async () => {
    const page = { items: [{ id: 'a-1' }], total: 1, limit: 50, offset: 0 };
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(jsonResponse(page));
    await expect(
      api.getAudit({ eventType: 'LOGIN_SUCCESS', actorId: '', limit: 50, offset: 0 }),
    ).resolves.toEqual(page);
    const [url] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('http://localhost:3000/audit?eventType=LOGIN_SUCCESS&limit=50&offset=0');
  });

  it('getAudit with no filters hits the bare endpoint', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(jsonResponse({ items: [], total: 0 }));
    await api.getAudit();
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(
      'http://localhost:3000/audit',
    );
  });

  it('signs the user out when an authenticated request returns 401 (expired session)', async () => {
    const onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);
    setToken('expired');
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      jsonResponse({ message: 'Unauthorized' }, { status: 401 }),
    );
    await expect(api.getQueue()).rejects.toMatchObject({ status: 401 });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    setUnauthorizedHandler(null);
  });

  it('does not treat a failed login (no token) as an expired session', async () => {
    const onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      jsonResponse({ message: 'Invalid credentials' }, { status: 401 }),
    );
    await expect(api.login('a@b.test', 'bad')).rejects.toMatchObject({ status: 401 });
    expect(onUnauthorized).not.toHaveBeenCalled();
    setUnauthorizedHandler(null);
  });

  it('exposes ApiError as an Error subclass', () => {
    const err = new ApiError(418, 'teapot');
    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBe(418);
  });

  // Exercise the whole typed client surface (every endpoint wrapper) so the
  // contract is covered, not just the two happy paths above.
  it.each([
    ['register', () => api.register('a@b.test', 'pw'), 'POST', '/auth/register'],
    ['submitRequest', () => api.submitRequest({} as never), 'POST', '/consultations'],
    ['getMine', () => api.getMine(), 'GET', '/consultations/mine'],
    ['getAssigned', () => api.getAssigned(), 'GET', '/consultations/assigned'],
    ['getPendingSignoff', () => api.getPendingSignoff(), 'GET', '/consultations/pending-signoff'],
    ['getConsultation', () => api.getConsultation('c-1'), 'GET', '/consultations/c-1'],
    ['claim', () => api.claim('c-1'), 'POST', '/consultations/c-1/claim'],
    ['start', () => api.start('c-1'), 'POST', '/consultations/c-1/start'],
    ['complete', () => api.complete('c-1'), 'POST', '/consultations/c-1/complete'],
    ['setPriority', () => api.setPriority('c-1', 'URGENT'), 'PATCH', '/consultations/c-1/priority'],
    ['getMessages', () => api.getMessages('c-1'), 'GET', '/consultations/c-1/messages'],
    ['sendMessage', () => api.sendMessage('c-1', 'hi'), 'POST', '/consultations/c-1/messages'],
    ['draftSummary', () => api.draftSummary('c-1', 'x'), 'POST', '/consultations/c-1/summary'],
    [
      'finalizeSummary',
      () => api.finalizeSummary('c-1'),
      'POST',
      '/consultations/c-1/summary/finalize',
    ],
    ['getSummary', () => api.getSummary('c-1'), 'GET', '/consultations/c-1/summary'],
    ['getSignedOff', () => api.getSignedOff(), 'GET', '/consultations/signed-off'],
    ['getAudit', () => api.getAudit(), 'GET', '/audit'],
    ['getUsers', () => api.getUsers(), 'GET', '/users'],
    ['deactivateUser', () => api.deactivateUser('u-1'), 'POST', '/users/u-1/deactivate'],
    ['reactivateUser', () => api.reactivateUser('u-1'), 'POST', '/users/u-1/reactivate'],
  ])('%s calls %s %s', async (_name, call, method, path) => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(jsonResponse({}));
    await call();
    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(`http://localhost:3000${path}`);
    // GET wrappers pass no explicit method (fetch defaults to GET).
    expect(init.method ?? 'GET').toBe(method);
  });
});
