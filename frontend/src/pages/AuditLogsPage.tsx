import React, { useEffect, useState, useCallback } from 'react';
import { ShieldAlert, Search, RefreshCw, ChevronLeft, ChevronRight, Filter } from 'lucide-react';
import { AuditLog } from '../types';
import { api } from '../api';
import { formatUtcDate } from '../date';
import { useToast } from '../components/Toast';

const ACTION_COLORS: Record<string, string> = {
  LAUNCH_JOB:            'bg-blue-50 text-blue-700 border-blue-200',
  CANCEL_JOB:            'bg-orange-50 text-orange-700 border-orange-200',
  CLEAR_PENDING_REBOOT:  'bg-cyan-50 text-cyan-700 border-cyan-200',
  SCHEDULE_SKIPPED:      'bg-amber-50 text-amber-700 border-amber-200',
  AWX_LAUNCH_FAILED:     'bg-rose-50 text-rose-700 border-rose-200',
  CREATE_USER:           'bg-emerald-50 text-emerald-700 border-emerald-200',
  UPDATE_USER:           'bg-indigo-50 text-indigo-700 border-indigo-200',
  UPDATE_PROFILE:        'bg-indigo-50 text-indigo-700 border-indigo-200',
  DELETE_USER:           'bg-rose-50 text-rose-700 border-rose-200',
  RESET_PASSWORD:        'bg-amber-50 text-amber-700 border-amber-200',
  CHANGE_PASSWORD:       'bg-amber-50 text-amber-700 border-amber-200',
  LOGIN:                 'bg-emerald-50 text-emerald-700 border-emerald-200',
  LOGOUT:                'bg-slate-100 text-slate-600 border-slate-200',
  LOGIN_FAILED:          'bg-amber-50 text-amber-800 border-amber-200',
  LOGIN_LOCKED:          'bg-rose-100 text-rose-800 border-rose-300',
};

const AUDIT_ACTIONS = [
  'LOGIN',
  'LOGOUT',
  'LOGIN_FAILED',
  'LOGIN_LOCKED',
  'CHANGE_PASSWORD',
  'UPDATE_PROFILE',
  'LAUNCH_JOB',
  'CANCEL_JOB',
  'CLEAR_PENDING_REBOOT',
  'SCHEDULE_SKIPPED',
  'AWX_LAUNCH_FAILED',
  'CREATE_USER',
  'UPDATE_USER',
  'DELETE_USER',
  'RESET_PASSWORD',
];

const PAGE_SIZE = 50;

export const AuditLogsPage: React.FC = () => {
  const { error: toastError } = useToast();
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [actionFilter, setActionFilter] = useState('');
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.getAuditLogs({
        search: search || undefined,
        action: actionFilter || undefined,
        offset: page * PAGE_SIZE,
        limit: PAGE_SIZE + 1,
      });
      if (data.length > PAGE_SIZE) {
        setHasMore(true);
        setLogs(data.slice(0, PAGE_SIZE));
      } else {
        setHasMore(false);
        setLogs(data);
      }
    } catch (e: any) {
      toastError('Failed to load audit logs', e.message);
    } finally {
      setLoading(false);
    }
  }, [search, actionFilter, page]);

  useEffect(() => { load(); }, [load]);

  const changeFilter = (setter: (v: string) => void) => (v: string) => {
    setter(v);
    setPage(0);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 border-b border-slate-200 pb-4">
        <div>
          <h2 className="text-xl font-bold text-slate-900 tracking-tight">Security &amp; Operation Audit Trail</h2>
          <p className="text-sm text-slate-500 mt-0.5">Immutable record of administrator operations, job launches, and access events.</p>
        </div>
        <button onClick={load} disabled={loading} className="p-2 rounded-lg border border-slate-300 bg-white text-slate-600 hover:bg-slate-50 transition-colors">
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin text-blue-600' : ''}`} />
        </button>
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3 p-4 rounded-xl bg-white border border-slate-200 shadow-sm">
        <div className="relative flex-1">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-2.5" />
          <input
            value={search}
            onChange={(e) => changeFilter(setSearch)(e.target.value)}
            placeholder="Search user, action, or resource…"
            className="w-full pl-9 pr-3 py-2 rounded-lg bg-white border border-slate-300 text-sm text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-600"
          />
        </div>
        <div className="flex items-center space-x-2">
          <Filter className="w-4 h-4 text-slate-400" />
          <select
            value={actionFilter}
            onChange={(e) => changeFilter(setActionFilter)(e.target.value)}
            className="px-3 py-2 rounded-lg bg-white border border-slate-300 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-600"
          >
            <option value="">All actions</option>
            {AUDIT_ACTIONS.map((a) => (
              <option key={a} value={a}>{a.replace(/_/g, ' ')}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Table */}
      <div className="rounded-xl border border-slate-200 bg-white overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-slate-600 text-xs font-semibold uppercase tracking-wider border-b border-slate-200">
              <tr>
                <th className="py-3 px-6">Timestamp</th>
                <th className="py-3 px-4">User</th>
                <th className="py-3 px-4">Action</th>
                <th className="py-3 px-4">Source IP</th>
                <th className="py-3 px-4">Target Resource</th>
                <th className="py-3 px-6">Event Details</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading && (
                <tr><td colSpan={6} className="py-10 text-center text-slate-400 text-sm">Loading audit records…</td></tr>
              )}
              {!loading && logs.length === 0 && (
                <tr><td colSpan={6} className="py-10 text-center text-slate-500 text-sm">No audit events matched the current filter.</td></tr>
              )}
              {logs.map((l) => (
                <tr key={l.id} className="hover:bg-slate-50/60 transition-colors">
                  <td className="py-3 px-6 text-xs text-slate-500 font-mono whitespace-nowrap">{formatUtcDate(l.timestamp)}</td>
                  <td className="py-3 px-4">
                    <div className="flex items-center space-x-2">
                      <div className="w-7 h-7 rounded-full bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center text-white font-bold text-xs">
                        {l.username.charAt(0).toUpperCase()}
                      </div>
                      <span className="text-xs font-semibold text-slate-800">{l.username}</span>
                    </div>
                  </td>
                  <td className="py-3 px-4">
                    <span className={`inline-flex px-2 py-0.5 rounded text-[11px] font-semibold uppercase tracking-wide border ${ACTION_COLORS[l.action] || 'bg-slate-100 text-slate-600 border-slate-200'}`}>
                      {l.action.replace(/_/g, ' ')}
                    </span>
                  </td>
                  <td className="py-3 px-4 text-xs font-mono text-slate-500 whitespace-nowrap">{l.ip_address || '—'}</td>
                  <td className="py-3 px-4 text-xs font-mono text-slate-700">{l.target_resource || '—'}</td>
                  <td className="py-3 px-6 text-xs text-slate-500 max-w-xs truncate" title={l.details}>{l.details || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        <div className="flex items-center justify-between px-6 py-3 border-t border-slate-200 bg-slate-50/50">
          <span className="text-xs text-slate-500">
            {loading ? 'Loading…' : `Page ${page + 1} — ${logs.length} record${logs.length !== 1 ? 's' : ''}`}
          </span>
          <div className="flex items-center space-x-2">
            <button onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0 || loading} className="flex items-center space-x-1 px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40 transition-colors">
              <ChevronLeft className="w-3.5 h-3.5" /><span>Previous</span>
            </button>
            <span className="px-3 py-1.5 rounded-lg bg-blue-600 text-white text-xs font-bold min-w-[2rem] text-center">{page + 1}</span>
            <button onClick={() => setPage((p) => p + 1)} disabled={!hasMore || loading} className="flex items-center space-x-1 px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40 transition-colors">
              <span>Next</span><ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
