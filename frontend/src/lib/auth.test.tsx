import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider, homePathFor, useAuth } from './auth';

const mock = vi.hoisted(() => ({ login: vi.fn(), register: vi.fn() }));
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

  it('throws when useAuth is used outside the provider', () => {
    expect(() => renderHook(() => useAuth())).toThrow(/within an AuthProvider/);
  });
});
