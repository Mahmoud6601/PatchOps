import React, { useState } from 'react';
import {
  ShieldCheck,
  Lock,
  User,
  ArrowRight,
  AlertCircle,
  CheckCircle2,
  Zap,
  Eye,
  EyeOff,
} from 'lucide-react';
import { api } from '../api';

interface LoginPageProps {
  onLoginSuccess: (token: string, role: string, username: string) => void;
}

const FEATURES = [
  { icon: ShieldCheck, label: 'Security Patch Automation', desc: 'Deploy CVE fixes fleet-wide in minutes' },
  { icon: Zap, label: 'Real-time Execution Telemetry', desc: 'Live stage tracking per endpoint' },
  { icon: CheckCircle2, label: 'Compliance Monitoring', desc: 'Know your patch posture at all times' },
];

export const LoginPage: React.FC<LoginPageProps> = ({ onLoginSuccess }) => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await api.login(username, password);
      onLoginSuccess(res.access_token, res.role, res.username);
    } catch (err: any) {
      setError(err.message || 'Invalid credentials. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex">
      {/* Left Panel — Brand */}
      <div className="hidden lg:flex lg:w-[55%] bg-gradient-to-br from-slate-900 via-blue-950 to-indigo-950 flex-col justify-between p-12 relative overflow-hidden">
        {/* Background pattern */}
        <div className="absolute inset-0 opacity-10">
          <div className="absolute top-20 left-20 w-72 h-72 rounded-full bg-blue-500 blur-[80px]" />
          <div className="absolute bottom-32 right-10 w-56 h-56 rounded-full bg-indigo-500 blur-[60px]" />
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-96 h-96 rounded-full bg-blue-800 blur-[100px]" />
        </div>

        {/* Grid pattern overlay */}
        <div
          className="absolute inset-0 opacity-[0.03]"
          style={{
            backgroundImage: 'linear-gradient(rgba(255,255,255,0.5) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.5) 1px, transparent 1px)',
            backgroundSize: '40px 40px',
          }}
        />

        {/* Top: Logo */}
        <div className="relative z-10 flex items-center space-x-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-blue-500 to-indigo-400 flex items-center justify-center shadow-lg shadow-blue-500/30">
            <ShieldCheck className="w-6 h-6 text-white" />
          </div>
          <div>
            <span className="text-white font-bold text-xl tracking-tight">PatchOps</span>
            <span className="ml-2 text-[10px] px-2 py-0.5 rounded-full bg-white/10 text-blue-200 font-mono">v1.0 · PROD</span>
          </div>
        </div>

        {/* Middle: Headline */}
        <div className="relative z-10 space-y-6">
          <div>
            <h2 className="text-4xl font-bold text-white leading-tight tracking-tight">
              Intelligent Endpoint<br />
              <span className="text-blue-400">Patch Management</span>
            </h2>
            <p className="mt-4 text-slate-400 text-base leading-relaxed max-w-sm">
              Automate OS patching across your entire fleet with real-time telemetry, compliance scoring, and audit trails.
            </p>
          </div>

          {/* Feature list */}
          <div className="space-y-4">
            {FEATURES.map((f, i) => (
              <div key={i} className="flex items-start space-x-3">
                <div className="w-8 h-8 rounded-lg bg-white/10 flex items-center justify-center shrink-0 border border-white/10">
                  <f.icon className="w-4 h-4 text-blue-400" />
                </div>
                <div>
                  <div className="text-white text-sm font-semibold">{f.label}</div>
                  <div className="text-slate-400 text-xs">{f.desc}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Bottom: Tagline */}
        <div className="relative z-10">
          <p className="text-slate-500 text-xs font-mono">
            Powered by Ansible AWX · Enterprise Security Standards
          </p>
        </div>
      </div>

      {/* Right Panel — Login Form */}
      <div className="flex-1 flex items-center justify-center bg-slate-50 p-8">
        <div className="w-full max-w-sm">
          {/* Mobile logo */}
          <div className="lg:hidden flex items-center space-x-2 mb-8 justify-center">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-blue-600 to-indigo-600 flex items-center justify-center">
              <ShieldCheck className="w-5 h-5 text-white" />
            </div>
            <span className="text-slate-900 font-bold text-lg">PatchOps</span>
          </div>

          <div className="mb-8">
            <h3 className="text-2xl font-bold text-slate-900 tracking-tight">Welcome back</h3>
            <p className="text-slate-500 text-sm mt-1">Sign in to your management console</p>
          </div>

          {error && (
            <div className="mb-6 p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-sm flex items-start space-x-2">
              <AlertCircle className="w-4 h-4 shrink-0 text-rose-500 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-5">
            {/* Username */}
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-2 uppercase tracking-wider">
                Username
              </label>
              <div className="relative">
                <User className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  required
                  autoFocus
                  autoComplete="username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="Enter your username"
                  className="w-full pl-10 pr-4 py-3 rounded-xl bg-white border border-slate-300 text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 text-sm shadow-xs transition-shadow"
                />
              </div>
            </div>

            {/* Password */}
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-2 uppercase tracking-wider">
                Password
              </label>
              <div className="relative">
                <Lock className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                <input
                  type={showPassword ? 'text' : 'password'}
                  required
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter your password"
                  className="w-full pl-10 pr-11 py-3 rounded-xl bg-white border border-slate-300 text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 text-sm shadow-xs transition-shadow"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute right-3.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 transition-colors"
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {/* Submit */}
            <button
              type="submit"
              disabled={loading || !username || !password}
              className="w-full py-3 rounded-xl bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white font-semibold text-sm shadow-md shadow-blue-600/20 transition-all flex items-center justify-center space-x-2 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? (
                <>
                  <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                  </svg>
                  <span>Authenticating…</span>
                </>
              ) : (
                <>
                  <span>Sign In to Console</span>
                  <ArrowRight className="w-4 h-4" />
                </>
              )}
            </button>
          </form>

          <div className="mt-8 pt-6 border-t border-slate-200 text-center">
            <p className="text-xs text-slate-400 font-mono">
              Secured with JWT · Role-based Access Control
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};
