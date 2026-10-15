import { createContext, ReactNode, useCallback, useContext, useMemo, useState } from 'react';
import { api, AuthUser, getToken, setToken } from './api';
import { disconnectRealtime } from './realtime';

const USER_KEY = 'vcp_user';

function loadUser(): AuthUser | null {
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? (JSON.parse(raw) as AuthUser) : null;
  } catch {
    return null;
  }
}

function storeUser(user: AuthUser | null): void {
  try {
    if (user) {
      localStorage.setItem(USER_KEY, JSON.stringify(user));
    } else {
      localStorage.removeItem(USER_KEY);
    }
  } catch {
    /* storage unavailable */
  }
}

interface AuthContextValue {
  user: AuthUser | null;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }): JSX.Element {
  const [user, setUser] = useState<AuthUser | null>(() => (getToken() ? loadUser() : null));

  const apply = useCallback((token: string, nextUser: AuthUser) => {
    setToken(token);
    storeUser(nextUser);
    setUser(nextUser);
  }, []);

  const login = useCallback(
    async (email: string, password: string) => {
      const result = await api.login(email, password);
      apply(result.accessToken, result.user);
    },
    [apply],
  );

  const register = useCallback(
    async (email: string, password: string) => {
      const result = await api.register(email, password);
      apply(result.accessToken, result.user);
    },
    [apply],
  );

  const logout = useCallback(() => {
    disconnectRealtime();
    setToken(null);
    storeUser(null);
    setUser(null);
  }, []);

  const value = useMemo(() => ({ user, login, register, logout }), [user, login, register, logout]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return ctx;
}

/** The screen a role lands on after login. */
export function homePathFor(role: AuthUser['role']): string {
  switch (role) {
    case 'PATIENT':
      return '/patient';
    case 'NURSE':
    case 'DOCTOR':
      return '/queue';
    case 'ADMIN':
      return '/audit';
    default:
      return '/login';
  }
}
