import { JSX } from 'react';
import { Link, NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Role } from './lib/api';
import { homePathFor, useAuth } from './lib/auth';
import AdminAudit from './screens/AdminAudit';
import AdminUsers from './screens/AdminUsers';
import ConsultationRoom from './screens/ConsultationRoom';
import Login from './screens/Login';
import MyConsultations from './screens/MyConsultations';
import PatientHome from './screens/PatientHome';
import SummaryScreen from './screens/Summary';
import TriageQueue from './screens/TriageQueue';

function RequireRole({ roles, children }: { roles: Role[]; children: JSX.Element }): JSX.Element {
  const { user } = useAuth();
  const location = useLocation();
  if (!user) {
    return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  }
  if (!roles.includes(user.role)) {
    return <Navigate to={homePathFor(user.role)} replace />;
  }
  return children;
}

/**
 * The login screen is only for signed-out visitors. An already-authenticated user
 * who lands here (e.g. by pressing Back after logging in) is bounced to their home
 * so the stale login form never shows alongside the signed-in nav bar.
 */
function RedirectIfAuthed({ children }: { children: JSX.Element }): JSX.Element {
  const { user } = useAuth();
  return user ? <Navigate to={homePathFor(user.role)} replace /> : children;
}

/** Primary navigation links for the signed-in user's role. */
function NavLinks({ role }: { role: Role }): JSX.Element {
  const links: Array<{ to: string; label: string }> =
    role === 'PATIENT'
      ? [{ to: '/patient', label: 'My consultations' }]
      : role === 'NURSE' || role === 'DOCTOR'
        ? [
            { to: '/queue', label: 'Triage queue' },
            { to: '/assigned', label: 'My consultations' },
          ]
        : [
            { to: '/users', label: 'Users' },
            { to: '/audit', label: 'Audit log' },
          ];
  return (
    <nav className="nav-links" aria-label="Primary">
      {links.map((l) => (
        <NavLink
          key={l.to}
          to={l.to}
          className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}
        >
          {l.label}
        </NavLink>
      ))}
    </nav>
  );
}

function NavBar(): JSX.Element | null {
  const { user, logout } = useAuth();
  if (!user) {
    return null;
  }
  return (
    <header className="nav">
      <Link to={homePathFor(user.role)} className="brand" aria-label="Go to home">
        <span className="brand-mark" aria-hidden="true">
          ⊕
        </span>
        Virtual Consultation Platform
      </Link>
      <span className={`badge badge-${user.role.toLowerCase()}`}>{user.role}</span>
      <NavLinks role={user.role} />
      <span className="spacer" />
      <span className="muted nav-email">{user.email}</span>
      <button className="secondary" onClick={logout}>
        Log out
      </button>
    </header>
  );
}

export default function App(): JSX.Element {
  const { user } = useAuth();
  const fallback = user ? homePathFor(user.role) : '/login';

  return (
    <div className="app">
      <NavBar />
      <main className="container">
        <Routes>
          <Route
            path="/login"
            element={
              <RedirectIfAuthed>
                <Login />
              </RedirectIfAuthed>
            }
          />
          <Route
            path="/patient"
            element={
              <RequireRole roles={['PATIENT']}>
                <PatientHome />
              </RequireRole>
            }
          />
          <Route
            path="/queue"
            element={
              <RequireRole roles={['NURSE', 'DOCTOR']}>
                <TriageQueue />
              </RequireRole>
            }
          />
          <Route
            path="/assigned"
            element={
              <RequireRole roles={['NURSE', 'DOCTOR']}>
                <MyConsultations />
              </RequireRole>
            }
          />
          <Route
            path="/consultations/:id"
            element={
              <RequireRole roles={['PATIENT', 'NURSE', 'DOCTOR']}>
                <ConsultationRoom />
              </RequireRole>
            }
          />
          <Route
            path="/consultations/:id/summary"
            element={
              <RequireRole roles={['PATIENT', 'NURSE', 'DOCTOR']}>
                <SummaryScreen />
              </RequireRole>
            }
          />
          <Route
            path="/users"
            element={
              <RequireRole roles={['ADMIN']}>
                <AdminUsers />
              </RequireRole>
            }
          />
          <Route
            path="/audit"
            element={
              <RequireRole roles={['ADMIN']}>
                <AdminAudit />
              </RequireRole>
            }
          />
          <Route path="*" element={<Navigate to={fallback} replace />} />
        </Routes>
      </main>
    </div>
  );
}
