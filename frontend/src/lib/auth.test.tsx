import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, setToken } from './api';
import { AuthProvider, homePathFor, isTokenExpired, useAuth } from './auth';

const mock = vi.hoisted(() => ({ login: vi.fn(), register: vi.fn(), getQueue: vi.fn() }));
vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>();
  return { ...actual, api: { ...actual.api, ...mock } };
});
const disconnectRealtime = vi.hoisted(() => vi.fn());
vi.mock('./realtime', () => ({ disconnectRealtime }));

const wrapper = ({ children }: { children: ReactNode }) => <AuthProvider>{children}</AuthProvider>;
const authResult = {
  accessToken: 'tok',
  user: { id: 'u', email: 'a@b.test', role: 'PATIENT' as const },
};

describe('homePathFor', () => {
  it('routes each role to its landing screen', () => {
    expect(homePathFor('PATIENT')).toBe('/patient');
    expect(homePathFor('NURSE')).toBe('/queue');
    expect(homePathFor('DOCTOR')).toBe('/queue');
    expect(homePathFor('ADMIN')).toBe('/audit');
  });
});

/** A JWT-shaped token whose payload carries only `exp` (signature is irrelevant client-side). */
function jwtExpiringAt(secondsFromNow: number): string {
  const payload = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + secondsFromNow }));
  return `header.${payload}.signature`;
}

describe('isTokenExpired', () => {
  it('reads the exp claim', () => {
    expect(isTokenExpired(jwtExpiringAt(-60))).toBe(true);
    expect(isTokenExpired(jwtExpiringAt(600))).toBe(false);
  });

  it('leaves unreadable tokens for the server to judge', () => {
    expect(isTokenExpired('not-a-jwt')).toBe(false);
  });
});

describe('AuthProvider', () => {
  beforeEach(() => {
    localStorage.clear();
    mock.login.mockReset().mockResolvedValue(authResult);
    mock.register.mockReset().mockResolvedValue(authResult);
    disconnectRealtime.mockReset();
  });

  it('starts with no user', () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    expect(result.current.user).toBeNull();
  });

  it('logs in and persists the user + token', async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    await act(async () => {
      await result.current.login('a@b.test', 'pw');
    });
    await waitFor(() => expect(result.current.user?.email).toBe('a@b.test'));
    expect(localStorage.getItem('vcp_token')).toBe('tok');
  });

  it('registers via the register API', async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    await act(async () => {
      await result.current.register('a@b.test', 'pw');
    });
    expect(mock.register).toHaveBeenCalled();
  });

  it('logs out, clearing state and the realtime socket', async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    await act(async () => {
      await result.current.login('a@b.test', 'pw');
    });
    act(() => result.current.logout());
    await waitFor(() => expect(result.current.user).toBeNull());
    expect(disconnectRealtime).toHaveBeenCalled();
    expect(localStorage.getItem('vcp_token')).toBeNull();
  });

  it('does not restore a session whose stored token has expired', () => {
    localStorage.setItem('vcp_token', jwtExpiringAt(-60));
    localStorage.setItem('vcp_user', JSON.stringify(authResult.user));
    const { result } = renderHook(() => useAuth(), { wrapper });
    expect(result.current.user).toBeNull();
    expect(localStorage.getItem('vcp_token')).toBeNull();
  });

  it('signs out with a reason when an authenticated request returns 401', async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    await act(async () => {
      await result.current.login('a@b.test', 'pw');
    });
    // Drive the real client: a 401 on a token-bearing call triggers the handler.
    setToken('tok');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        json: async () => ({ message: 'Unauthorized' }),
      }),
    );
    const realGetQueue = (await vi.importActual<typeof import('./api')>('./api')).api.getQueue;
    await act(async () => {
      await expect(realGetQueue()).rejects.toBeInstanceOf(ApiError);
    });
    vi.unstubAllGlobals();
    await waitFor(() => expect(result.current.user).toBeNull());
    expect(result.current.signOutReason).toMatch(/session has ended/i);
  });

  it('throws when useAuth is used outside the provider', () => {
    expect(() => renderHook(() => useAuth())).toThrow(/within an AuthProvider/);
  });
});
