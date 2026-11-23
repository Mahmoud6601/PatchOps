import React, { useState, useEffect, useRef } from 'react';
import {
  ShieldCheck,
  LogOut,
  User as UserIcon,
  Settings,
  ChevronDown,
  Wifi,
  WifiOff,
  AlertCircle,
  X,
  KeyRound,
  Lock,
  Download,
  Radio,
  Globe,
  CheckCircle2,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { User } from '../types';
import { api } from '../api';
import { useToast } from './Toast';

interface NavbarProps {
  user: User | null;
  onLogout: () => void;
  onUserUpdated?: (updated: User) => void;
}

type AwxStatus = 'checking' | 'online' | 'offline' | 'unknown';

export const Navbar: React.FC<NavbarProps> = ({ user, onLogout, onUserUpdated }) => {
  const { success, error: toastError } = useToast();
  const [awxStatus, setAwxStatus] = useState<AwxStatus>('checking');
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Profile Modal State
  const [profileOpen, setProfileOpen] = useState(false);
  const [profileTab, setProfileTab] = useState<'details' | 'password'>('details');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [savingProfile, setSavingProfile] = useState(false);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [savingPassword, setSavingPassword] = useState(false);

  // Settings Modal State
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [liveStreamEnabled, setLiveStreamEnabled] = useState<boolean>(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('patching_live_stream') !== 'false';
    }
    return true;
  });
  const [defaultTimezone, setDefaultTimezone] = useState<string>(() => {
    if (typeof window !== 'undefined') {
      return (
        localStorage.getItem('patching_default_timezone') ||
        Intl.DateTimeFormat().resolvedOptions().timeZone ||
        'UTC'
      );
    }
    return 'UTC';
  });

  const checkAwx = async () => {
    try {
      const result = await api.checkAwxHealth();
      setAwxStatus(result.status === 'online' ? 'online' : 'offline');
    } catch {
      setAwxStatus('offline');
    }
  };

  useEffect(() => {
    checkAwx();
    const interval = setInterval(checkAwx, 60_000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const openProfileModal = (initialTab: 'details' | 'password' = 'details') => {
    setDropdownOpen(false);
    setFullName(user?.full_name || '');
    setEmail(user?.email || '');
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');
    setProfileTab(initialTab);
    setProfileOpen(true);
  };

  const openSettingsModal = () => {
    setDropdownOpen(false);
    setSettingsOpen(true);
  };

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingProfile(true);
    try {
      const updated = await api.updateMyProfile({
        full_name: fullName.trim() || null,
        email: email.trim() || null,
      });
      onUserUpdated?.(updated);
      success('Profile Updated', 'Your account details have been saved.');
      setProfileOpen(false);
    } catch (err: any) {
      toastError('Update Failed', err.message || 'Could not update profile');
    } finally {
      setSavingProfile(false);
    }
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPassword.length < 12) {
      toastError('Password Too Short', 'New password must be at least 12 characters.');
      return;
    }
    if (newPassword !== confirmPassword) {
      toastError('Password Mismatch', 'New password and confirmation do not match.');
      return;
    }
    setSavingPassword(true);
    try {
      await api.changeMyPassword(currentPassword, newPassword);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      success('Password Changed', 'Your password was updated and other active sessions were revoked.');
      setProfileOpen(false);
    } catch (err: any) {
      toastError('Password Change Failed', err.message || 'Could not change password');
    } finally {
      setSavingPassword(false);
    }
  };

  const handleSaveSettings = (e: React.FormEvent) => {
    e.preventDefault();
    if (typeof window !== 'undefined') {
      localStorage.setItem('patching_live_stream', String(liveStreamEnabled));
      localStorage.setItem('patching_default_timezone', defaultTimezone.trim() || 'UTC');
    }
    success('Preferences Saved', 'Workspace streaming and timezone preferences updated.');
    setSettingsOpen(false);
  };

  const renderScopeSummary = () => {
    if (!user || user.role === 'administrator') {
      return 'Full Platform Access (All Customers & OS)';
    }
    const osLabel =
      user.allowed_os_families && user.allowed_os_families.length > 0
        ? user.allowed_os_families.map((o) => o.toUpperCase()).join(', ')
        : 'All OS';
    const grpLabel =
      user.allowed_group_ids && user.allowed_group_ids.length > 0
        ? `${user.allowed_group_ids.length} Assigned Customer(s)`
        : 'All Customers';
    return `${grpLabel} · ${osLabel}`;
  };

  const awxBadge = () => {
    if (awxStatus === 'checking') {
      return (
        <div className="flex items-center space-x-2 px-3 py-1 rounded-full bg-slate-50 border border-slate-200 text-xs">
          <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
          <span className="text-slate-600 font-mono font-medium">AWX Checking…</span>
        </div>
      );
    }
    if (awxStatus === 'online') {
      return (
        <div className="flex items-center space-x-2 px-3 py-1 rounded-full bg-emerald-50 border border-emerald-200 text-xs">
          <Wifi className="w-3.5 h-3.5 text-emerald-600" />
          <span className="text-emerald-700 font-mono font-medium">AWX Online</span>
        </div>
      );
    }
    if (awxStatus === 'offline') {
      return (
        <div className="flex items-center space-x-2 px-3 py-1 rounded-full bg-rose-50 border border-rose-200 text-xs">
          <WifiOff className="w-3.5 h-3.5 text-rose-600" />
          <span className="text-rose-700 font-mono font-medium">AWX Offline</span>
        </div>
      );
    }
    return (
      <div className="flex items-center space-x-2 px-3 py-1 rounded-full bg-slate-50 border border-slate-200 text-xs">
        <AlertCircle className="w-3.5 h-3.5 text-slate-400" />
        <span className="text-slate-600 font-mono font-medium">AWX Unknown</span>
      </div>
    );
  };

  return (
    <>
      <header className="h-16 border-b border-slate-200 bg-white/95 backdrop-blur-md sticky top-0 z-40 px-6 flex items-center justify-between shadow-xs">
        {/* Brand */}
        <Link to="/dashboard" className="flex items-center space-x-3 group">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-blue-600 to-indigo-600 flex items-center justify-center shadow-md shadow-blue-500/25 group-hover:scale-105 transition-transform">
            <ShieldCheck className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-base font-bold text-slate-900 tracking-tight flex items-center space-x-2">
              <span>PatchOps</span>
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200 font-mono font-medium">
                v1.0 · PROD
              </span>
            </h1>
            <p className="text-[11px] text-slate-400 font-medium">Intelligent Endpoint &amp; Patch Management</p>
          </div>
        </Link>

        {/* Right side */}
        <div className="flex items-center space-x-4">
          {awxBadge()}

          {/* User dropdown */}
          <div className="relative pl-4 border-l border-slate-200" ref={dropdownRef}>
            <button
              onClick={() => setDropdownOpen((v) => !v)}
              className="flex items-center space-x-2.5 hover:bg-slate-50 rounded-lg px-2 py-1.5 transition-colors"
            >
              <div className="w-8 h-8 rounded-full bg-gradient-to-tr from-blue-500 to-indigo-500 flex items-center justify-center text-white font-bold text-xs shadow-sm">
                {user?.username?.charAt(0).toUpperCase() || 'A'}
              </div>
              <div className="hidden md:block text-left">
                <div className="text-xs font-semibold text-slate-800 leading-tight">{user?.full_name || user?.username}</div>
                <div className="text-[10px] text-blue-600 uppercase tracking-wider font-mono font-medium leading-tight">
                  {user?.role}
                </div>
              </div>
              <ChevronDown className={`w-3.5 h-3.5 text-slate-400 transition-transform ${dropdownOpen ? 'rotate-180' : ''}`} />
            </button>

            {dropdownOpen && (
              <div className="absolute right-0 top-full mt-2 w-60 rounded-xl bg-white border border-slate-200 shadow-lg shadow-slate-200/60 z-50 overflow-hidden">
                <div className="px-4 py-3 border-b border-slate-100 bg-slate-50/60">
                  <div className="text-xs font-semibold text-slate-800 truncate">{user?.full_name || user?.username}</div>
                  <div className="text-[11px] text-slate-500 truncate">{user?.email || `@${user?.username}`}</div>
                  <div className="mt-1.5 flex items-center flex-wrap gap-1">
                    <span className={`inline-flex px-2 py-0.5 rounded text-[10px] font-mono font-semibold uppercase ${
                      user?.role === 'administrator'
                        ? 'bg-blue-50 text-blue-700 border border-blue-200'
                        : user?.role === 'operator'
                        ? 'bg-indigo-50 text-indigo-700 border border-indigo-200'
                        : 'bg-slate-100 text-slate-600 border border-slate-200'
                    }`}>
                      {user?.role}
                    </span>
                  </div>
                </div>

                <div className="py-1">
                  <button
                    type="button"
                    className="w-full flex items-center space-x-3 px-4 py-2.5 text-sm text-slate-700 hover:bg-slate-50 transition-colors"
                    onClick={() => openProfileModal('details')}
                  >
                    <UserIcon className="w-4 h-4 text-blue-600" />
                    <span className="text-xs font-medium">My Profile &amp; Password</span>
                  </button>
                  <button
                    type="button"
                    className="w-full flex items-center space-x-3 px-4 py-2.5 text-sm text-slate-700 hover:bg-slate-50 transition-colors"
                    onClick={openSettingsModal}
                  >
                    <Settings className="w-4 h-4 text-indigo-600" />
                    <span className="text-xs font-medium">Workspace Settings</span>
                  </button>
                </div>

                <div className="border-t border-slate-100 py-1">
                  <button
                    type="button"
                    onClick={() => { setDropdownOpen(false); onLogout(); }}
                    className="w-full flex items-center space-x-3 px-4 py-2.5 text-xs font-medium text-rose-600 hover:bg-rose-50 transition-colors"
                  >
                    <LogOut className="w-4 h-4" />
                    <span>Sign Out</span>
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </header>

      {/* My Profile & Self-Service Password Modal */}
      {profileOpen && user && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-md"
          onClick={() => setProfileOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-2xl bg-white border border-slate-200 shadow-2xl overflow-hidden"
            style={{ animation: 'scaleIn 0.18s ease-out' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between bg-slate-50/70">
              <div className="flex items-center space-x-3">
                <div className="w-9 h-9 rounded-full bg-gradient-to-tr from-blue-600 to-indigo-600 flex items-center justify-center text-white font-bold text-sm">
                  {user.username.charAt(0).toUpperCase()}
                </div>
                <div>
                  <h3 className="text-sm font-bold text-slate-900">My Account &amp; Security</h3>
                  <p className="text-[11px] text-slate-500 font-mono">@{user.username} · {user.role}</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setProfileOpen(false)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="px-6 pt-4">
              <div className="p-3 rounded-xl bg-blue-50/60 border border-blue-100 text-xs flex items-center justify-between">
                <span className="text-slate-600 font-medium">Assigned RBAC Scope:</span>
                <span className="font-semibold text-blue-800 font-mono text-[11px]">{renderScopeSummary()}</span>
              </div>

              <div className="grid grid-cols-2 gap-1 p-1 mt-4 rounded-xl bg-slate-100">
                <button
                  type="button"
                  onClick={() => setProfileTab('details')}
                  className={`py-1.5 rounded-lg text-xs font-semibold transition-all ${
                    profileTab === 'details'
                      ? 'bg-white text-blue-700 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  Profile Details
                </button>
                <button
                  type="button"
                  onClick={() => setProfileTab('password')}
                  className={`py-1.5 rounded-lg text-xs font-semibold transition-all flex items-center justify-center space-x-1.5 ${
                    profileTab === 'password'
                      ? 'bg-white text-blue-700 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  <KeyRound className="w-3.5 h-3.5" />
                  <span>Change Password</span>
                </button>
              </div>
            </div>

            {profileTab === 'details' ? (
              <form onSubmit={handleSaveProfile} className="p-6 space-y-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Username</label>
                  <input
                    disabled
                    value={user.username}
                    className="w-full px-3 py-2 rounded-lg border border-slate-200 bg-slate-50 text-slate-500 text-sm font-mono cursor-not-allowed"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Full Name</label>
                  <input
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                    placeholder="e.g. Jane Doe"
                    className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-600"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Email Address</label>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="name@enterprise.local"
                    className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-600"
                  />
                </div>
                <div className="flex justify-end space-x-2 pt-2 border-t border-slate-100">
                  <button
                    type="button"
                    onClick={() => setProfileOpen(false)}
                    className="px-4 py-2 rounded-lg border border-slate-300 bg-white text-slate-700 text-xs font-semibold hover:bg-slate-50"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={savingProfile}
                    className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold shadow-sm disabled:opacity-50"
                  >
                    {savingProfile ? 'Saving…' : 'Save Profile'}
                  </button>
                </div>
              </form>
            ) : (
              <form onSubmit={handleChangePassword} className="p-6 space-y-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Current Password *</label>
                  <input
                    required
                    type="password"
                    value={currentPassword}
                    onChange={(e) => setCurrentPassword(e.target.value)}
                    placeholder="Enter current password"
                    className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-600"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    New Password * <span className="text-slate-400 font-normal">(min 12 characters)</span>
                  </label>
                  <input
                    required
                    type="password"
                    minLength={12}
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="At least 12 characters"
                    className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-600"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Confirm New Password *</label>
                  <input
                    required
                    type="password"
                    minLength={12}
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="Re-enter new password"
                    className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-600"
                  />
                </div>
                <div className="flex justify-end space-x-2 pt-2 border-t border-slate-100">
                  <button
                    type="button"
                    onClick={() => setProfileOpen(false)}
                    className="px-4 py-2 rounded-lg border border-slate-300 bg-white text-slate-700 text-xs font-semibold hover:bg-slate-50"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={savingPassword}
                    className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold shadow-sm disabled:opacity-50"
                  >
                    {savingPassword ? 'Updating…' : 'Update Password'}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}

      {/* Workspace & Platform Settings Modal */}
      {settingsOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-md"
          onClick={() => setSettingsOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-2xl bg-white border border-slate-200 shadow-2xl overflow-hidden"
            style={{ animation: 'scaleIn 0.18s ease-out' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between bg-slate-50/70">
              <div className="flex items-center space-x-2.5">
                <Settings className="w-4 h-4 text-indigo-600" />
                <h3 className="text-sm font-bold text-slate-900">Workspace &amp; Platform Settings</h3>
              </div>
              <button
                type="button"
                onClick={() => setSettingsOpen(false)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSaveSettings} className="p-6 space-y-5">
              <div className="flex items-start justify-between gap-4 p-3.5 rounded-xl border border-slate-200 bg-slate-50/60">
                <div className="space-y-0.5">
                  <div className="flex items-center space-x-1.5 text-xs font-semibold text-slate-900">
                    <Radio className="w-3.5 h-3.5 text-emerald-600" />
                    <span>Real-Time SSE Event Streaming</span>
                  </div>
                  <p className="text-[11px] text-slate-500 leading-relaxed">
                    Push instant stage progress, host logs, and fleet telemetry via Server-Sent Events instead of periodic HTTP polling.
                  </p>
                </div>
                <input
                  type="checkbox"
                  checked={liveStreamEnabled}
                  onChange={(e) => setLiveStreamEnabled(e.target.checked)}
                  className="mt-1 h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1 flex items-center space-x-1.5">
                  <Globe className="w-3.5 h-3.5 text-blue-600" />
                  <span>Default Automation Timezone (IANA)</span>
                </label>
                <input
                  value={defaultTimezone}
                  onChange={(e) => setDefaultTimezone(e.target.value)}
                  placeholder="Africa/Cairo"
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 text-xs font-mono text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-600"
                />
                <p className="text-[11px] text-slate-400 mt-1">
                  Pre-selected when creating new automation schedules.
                </p>
              </div>

              <div className="p-3.5 rounded-xl bg-emerald-50/60 border border-emerald-200 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center space-x-1.5 text-xs font-semibold text-emerald-950">
                    <Lock className="w-3.5 h-3.5 text-emerald-700" />
                    <span>Platform TLS &amp; Internal PKI</span>
                  </div>
                  <span className="inline-flex items-center space-x-1 text-[10px] font-mono font-semibold text-emerald-700">
                    <CheckCircle2 className="w-3 h-3" />
                    <span>HTTPS Active</span>
                  </span>
                </div>
                <p className="text-[11px] text-emerald-900 leading-relaxed">
                  Download the PatchOps Root CA certificate to trust HTTPS in your browser and verify WinRM TLS endpoints.
                </p>
                <a
                  href="/api/health/ca.crt"
                  download="patchops-root-ca.crt"
                  className="inline-flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold transition-colors shadow-xs"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Download Root CA (.crt)</span>
                </a>
              </div>

              <div className="flex justify-end space-x-2 pt-2 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setSettingsOpen(false)}
                  className="px-4 py-2 rounded-lg border border-slate-300 bg-white text-slate-700 text-xs font-semibold hover:bg-slate-50"
                >
                  Close
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold shadow-sm"
                >
                  Save Preferences
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
};
