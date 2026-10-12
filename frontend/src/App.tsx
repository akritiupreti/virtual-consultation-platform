import { JSX } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Role } from './lib/api';
import { homePathFor, useAuth } from './lib/auth';
import AdminAudit from './screens/AdminAudit';
import ConsultationRoom from './screens/ConsultationRoom';
import Login from './screens/Login';
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

function NavBar(): JSX.Element | null {
  const { user, logout } = useAuth();
  if (!user) {
    return null;
  }
  return (
    <header className="nav">
      <span className="brand">Virtual Consultation Platform</span>
      <span className={`badge badge-${user.role.toLowerCase()}`}>{user.role}</span>
      <span className="spacer" />
      <span className="muted">{user.email}</span>
      <button className="link-btn" onClick={logout}>
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
          <Route path="/login" element={<Login />} />
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
