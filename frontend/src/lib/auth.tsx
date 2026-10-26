import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { api, AuthUser, getToken, setToken, setUnauthorizedHandler } from './api';
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

/**
 * True when the stored JWT's `exp` claim is in the past. Only the expiry is read —
 * the signature is the server's to check — so a stale token left in storage does
 * not render a signed-in shell whose every request will 401.
 */
export function isTokenExpired(token: string, now = Date.now()): boolean {
  try {
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))) as {
      exp?: number;
    };
    return typeof payload.exp === 'number' && payload.exp * 1000 <= now;
  } catch {
    // Not a JWT we can read; let the server decide.
    return false;
  }
}

function initialUser(): AuthUser | null {
  const token = getToken();
  if (!token) {
    return null;
  }
  if (isTokenExpired(token)) {
    setToken(null);
    return null;
  }
  return loadUser();
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
  /** Why the user was signed out, shown on the login screen (e.g. session expired). */
  signOutReason: string | null;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }): JSX.Element {
  const [user, setUser] = useState<AuthUser | null>(initialUser);
  const [signOutReason, setSignOutReason] = useState<string | null>(null);

  const apply = useCallback((token: string, nextUser: AuthUser) => {
    setToken(token);
    storeUser(nextUser);
    setUser(nextUser);
    setSignOutReason(null);
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

  // An authenticated request that comes back 401 means the session ended (JWT
  // expiry, or the account was deactivated): sign out and say why, instead of
  // leaving a signed-in shell where every action fails.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      logout();
      setSignOutReason('Your session has ended. Please log in again.');
    });
    return () => setUnauthorizedHandler(null);
  }, [logout]);

  const value = useMemo(
    () => ({ user, signOutReason, login, register, logout }),
    [user, signOutReason, login, register, logout],
  );

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
