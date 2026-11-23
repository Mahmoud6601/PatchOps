import React, { useState, useEffect } from 'react';
import {
  BrowserRouter,
  Routes,
  Route,
  Navigate,
  useNavigate,
  useParams,
} from 'react-router-dom';
import { Navbar } from './components/Navbar';
import { Sidebar } from './components/Sidebar';
import { DashboardPage } from './pages/DashboardPage';
import { ServersPage } from './pages/ServersPage';
import { JobDetailPage } from './pages/JobDetailPage';
import { BuildHistoryPage } from './pages/BuildHistoryPage';
import { SchedulesPage } from './pages/SchedulesPage';
import { AuditLogsPage } from './pages/AuditLogsPage';
import { LoginPage } from './pages/LoginPage';
import { UsersPage } from './pages/UsersPage';
import { ToastProvider } from './components/Toast';
import { User } from './types';
import { api } from './api';

const USER_STORAGE_KEY = 'patching_cached_user';

const RunDetailRoute: React.FC<{
  currentUser: User;
  onNavigateToBuild: (buildId: string) => void;
}> = ({ currentUser, onNavigateToBuild }) => {
  const { buildId } = useParams<{ buildId: string }>();
  const navigate = useNavigate();
  const decodedId = buildId ? decodeURIComponent(buildId) : '';
  if (!decodedId) {
    return <Navigate to="/runs" replace />;
  }
  return (
    <JobDetailPage
      buildId={decodedId}
      currentUser={currentUser}
      onBack={() => navigate('/runs')}
      onNavigateToBuild={onNavigateToBuild}
    />
  );
};

const AuthenticatedShell: React.FC<{
  user: User;
  onLogout: () => void;
  onUserUpdated: (updated: User) => void;
}> = ({ user, onLogout, onUserUpdated }) => {
  const navigate = useNavigate();

  const handleNavigateToBuild = (buildId: string) => {
    navigate(`/runs/${encodeURIComponent(buildId)}`);
  };

  const handleNavigateToServers = (groupId?: number | null) => {
    if (groupId !== undefined && groupId !== null && typeof window !== 'undefined') {
      const stored = sessionStorage.getItem('patching_servers_filters');
      const parsed = stored ? JSON.parse(stored) : {};
      parsed.customerFilter = String(groupId);
      sessionStorage.setItem('patching_servers_filters', JSON.stringify(parsed));
      navigate(`/servers?group=${encodeURIComponent(String(groupId))}`);
      return;
    }
    navigate('/servers');
  };

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col text-slate-900">
      <Navbar user={user} onLogout={onLogout} onUserUpdated={onUserUpdated} />
      <div className="flex-1 flex overflow-hidden">
        <Sidebar currentUser={user} />
        <main className="flex-1 p-8 overflow-y-auto max-h-[calc(100vh-4rem)] bg-slate-50 transition-all">
          <Routes>
            <Route path="/" element={<Navigate to="/dashboard" replace />} />
            <Route
              path="/dashboard"
              element={
                <DashboardPage
                  currentUser={user}
                  onNavigateToBuild={handleNavigateToBuild}
                  onNavigateToServers={handleNavigateToServers}
                />
              }
            />
            <Route
              path="/servers"
              element={<ServersPage currentUser={user} onNavigateToBuild={handleNavigateToBuild} />}
            />
            <Route
              path="/runs"
              element={<BuildHistoryPage onNavigateToBuild={handleNavigateToBuild} />}
            />
            <Route path="/builds" element={<Navigate to="/runs" replace />} />
            <Route
              path="/runs/:buildId"
              element={
                <RunDetailRoute
                  currentUser={user}
                  onNavigateToBuild={handleNavigateToBuild}
                />
              }
            />
            <Route path="/schedules" element={<SchedulesPage currentUser={user} />} />
            <Route
              path="/audit"
              element={
                user.role === 'administrator' ? (
                  <AuditLogsPage />
                ) : (
                  <Navigate to="/dashboard" replace />
                )
              }
            />
            <Route
              path="/users"
              element={
                user.role === 'administrator' ? (
                  <UsersPage currentUser={user} />
                ) : (
                  <Navigate to="/dashboard" replace />
                )
              }
            />
            <Route path="*" element={<Navigate to="/dashboard" replace />} />
          </Routes>
        </main>
      </div>
    </div>
  );
};

export function App() {
  const [token, setToken] = useState<string | null>(null);
  const [bootstrapping, setBootstrapping] = useState<boolean>(true);

  const [user, setUser] = useState<User | null>(() => {
    if (typeof window !== 'undefined') {
      const cached = localStorage.getItem(USER_STORAGE_KEY);
      if (cached) {
        try {
          return JSON.parse(cached);
        } catch {
          // ignore corrupted JSON
        }
      }
    }
    return null;
  });

  useEffect(() => {
    let cancelled = false;
    api.refreshSession()
      .then((refreshedToken) => {
        if (cancelled) return;
        if (refreshedToken) {
          setToken(refreshedToken);
        } else {
          setToken(null);
          setUser(null);
          if (typeof window !== 'undefined') {
            localStorage.removeItem(USER_STORAGE_KEY);
          }
        }
      })
      .finally(() => {
        if (!cancelled) setBootstrapping(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (bootstrapping) return;
    if (token) {
      api.getMe()
        .then((userData) => {
          setUser(userData);
          if (typeof window !== 'undefined') {
            localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(userData));
          }
        })
        .catch((err) => {
          console.warn('Session verification error (retaining current token):', err);
        });
    } else {
      setUser(null);
      if (typeof window !== 'undefined') {
        localStorage.removeItem(USER_STORAGE_KEY);
      }
    }
  }, [token, bootstrapping]);

  useEffect(() => {
    const expire = () => {
      api.setAccessToken(null);
      setToken(null);
      setUser(null);
      if (typeof window !== 'undefined') {
        localStorage.removeItem(USER_STORAGE_KEY);
      }
    };
    window.addEventListener('patching-auth-expired', expire);
    return () => window.removeEventListener('patching-auth-expired', expire);
  }, []);

  const handleLoginSuccess = (newToken: string, _role: string, _username: string) => {
    api.setAccessToken(newToken);
    setToken(newToken);
  };

  const handleLogout = () => {
    api.logout().catch(() => {
      // Ignore network errors while revoking server session
    });
    api.setAccessToken(null);
    setToken(null);
    setUser(null);
    if (typeof window !== 'undefined') {
      localStorage.removeItem(USER_STORAGE_KEY);
    }
  };

  const handleUserUpdated = (updated: User) => {
    setUser(updated);
    if (typeof window !== 'undefined') {
      localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(updated));
    }
  };

  if (bootstrapping) {
    return (
      <div className="min-h-screen bg-slate-50 grid place-items-center text-sm text-slate-600 font-medium">
        Verifying secure session…
      </div>
    );
  }
  if (!token) {
    return <LoginPage onLoginSuccess={handleLoginSuccess} />;
  }
  if (!user) {
    return (
      <div className="min-h-screen bg-slate-50 grid place-items-center text-sm text-slate-600 font-medium">
        Loading authenticated session…
      </div>
    );
  }

  return (
    <ToastProvider>
      <BrowserRouter>
        <AuthenticatedShell
          user={user}
          onLogout={handleLogout}
          onUserUpdated={handleUserUpdated}
        />
      </BrowserRouter>
    </ToastProvider>
  );
}

export default App;
