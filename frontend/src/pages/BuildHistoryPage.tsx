import React, { useEffect, useState } from 'react';
import { ArrowUpRight, Download, Search, ChevronLeft, ChevronRight, History, Filter } from 'lucide-react';
import { UpdateJob } from '../types';
import { api } from '../api';
import { useToast } from '../components/Toast';
import { formatUtcDate, formatDuration } from '../date';

interface BuildHistoryPageProps {
  onNavigateToBuild: (buildId: string) => void;
}

const PAGE_SIZE = 25;

export const BuildHistoryPage: React.FC<BuildHistoryPageProps> = ({ onNavigateToBuild }) => {
  const { error: toastError } = useToast();
  const [jobs, setJobs] = useState<UpdateJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [updateType, setUpdateType] = useState('');
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [error, setError] = useState('');

  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    let initialFrame = true;
    const unsubscribe = api.subscribeSse('/stream/fleet', (eventName) => {
      if (eventName === 'fleet_update') {
        if (initialFrame) {
          initialFrame = false;
          return;
        }
        setRefreshTick((t) => t + 1);
      }
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    let current = true;
    if (jobs.length === 0) setLoading(true);
    setError('');
    api
      .getJobs({
        offset: page * PAGE_SIZE,
        limit: PAGE_SIZE + 1,
        search: search || undefined,
        status: status || undefined,
        update_type: updateType || undefined,
      })
      .then((result) => {
        if (!current) return;
        if (result.length > PAGE_SIZE) {
          setHasMore(true);
          setJobs(result.slice(0, PAGE_SIZE));
        } else {
          setHasMore(false);
          setJobs(result);
        }
      })
      .catch((err: Error) => {
        if (current) setError(err.message);
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [page, search, status, updateType, refreshTick]);

  const changeFilter = (setter: (value: string) => void) => (value: string) => {
    setter(value);
    setPage(0);
  };

  const downloadHistory = async () => {
    try {
      await api.downloadPatchHistory();
    } catch (err) {
      toastError('Export Failed', err instanceof Error ? err.message : 'Could not export history');
    }
  };

  const statusClass = (value: string) => {
    if (value === 'success') return 'bg-emerald-50 text-emerald-700 border border-emerald-200';
    if (value === 'running') return 'bg-blue-50 text-blue-700 border border-blue-200 animate-pulse';
    if (value === 'pending') return 'bg-amber-50 text-amber-700 border border-amber-200';
    if (value === 'cancelled') return 'bg-slate-100 text-slate-600 border border-slate-200';
    return 'bg-rose-50 text-rose-700 border border-rose-200';
  };

  const typeClass = (value: string) => {
    if (value === 'discovery') return 'bg-indigo-50 text-indigo-700 border border-indigo-200';
    if (value === 'security') return 'bg-rose-50 text-rose-700 border border-rose-200';
    if (value === 'regular') return 'bg-blue-50 text-blue-700 border border-blue-200';
    if (value === 'major_upgrade') return 'bg-purple-50 text-purple-700 border border-purple-200';
    return 'bg-slate-100 text-slate-600 border border-slate-200';
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 pb-4 border-b border-slate-200">
        <div className="flex items-center space-x-3">
          <div className="p-2.5 rounded-xl bg-blue-50 border border-blue-100">
            <History className="w-5 h-5 text-blue-600" />
          </div>
          <div>
            <h2 className="text-xl font-bold text-slate-900 tracking-tight">Execution History</h2>
            <p className="text-sm text-slate-500 mt-0.5">AWX-backed runs with per-host stage telemetry and logs.</p>
          </div>
        </div>
        <button
          onClick={downloadHistory}
          className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg bg-white hover:bg-slate-50 border border-slate-300 text-slate-700 font-medium text-xs shadow-xs transition-colors"
        >
          <Download className="w-4 h-4" /> Export CSV
        </button>
      </div>

      {/* Filters */}
      <div className="flex flex-col lg:flex-row gap-3 p-4 rounded-xl bg-white border border-slate-200 shadow-xs">
        <div className="relative flex-1">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-3" />
          <input
            value={search}
            onChange={(e) => changeFilter(setSearch)(e.target.value)}
            placeholder="Search by run ID, job name, or initiated by…"
            className="w-full pl-9 pr-3 py-2 rounded-lg bg-white border border-slate-300 text-sm text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
          />
        </div>
        <div className="flex items-center space-x-2">
          <Filter className="w-4 h-4 text-slate-400 shrink-0" />
          <select
            value={status}
            onChange={(e) => changeFilter(setStatus)(e.target.value)}
            className="px-3 py-2 rounded-lg bg-white border border-slate-300 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
          >
            <option value="">All Statuses</option>
            {['pending', 'running', 'success', 'failed', 'cancelled'].map((v) => (
              <option key={v} value={v}>
                {v.charAt(0).toUpperCase() + v.slice(1)}
              </option>
            ))}
          </select>
          <select
            value={updateType}
            onChange={(e) => changeFilter(setUpdateType)(e.target.value)}
            className="px-3 py-2 rounded-lg bg-white border border-slate-300 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
          >
            <option value="">All Types</option>
            {['discovery', 'security', 'regular', 'major_upgrade'].map((v) => (
              <option key={v} value={v}>
                {v.replace('_', ' ').replace(/\b\w/g, (c) => c.toUpperCase())}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-sm">
          {error}
        </div>
      )}

      {/* Table */}
      <div className="rounded-xl border border-slate-200 bg-white overflow-hidden shadow-xs">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-slate-500 text-[11px] font-mono uppercase border-b border-slate-200">
              <tr>
                <th className="py-3 px-5">Run ID</th>
                <th className="py-3 px-5">Workflow</th>
                <th className="py-3 px-4">Type</th>
                <th className="py-3 px-4">Status</th>
                <th className="py-3 px-4">Initiated By</th>
                <th className="py-3 px-4">Targets</th>
                <th className="py-3 px-4">Duration</th>
                <th className="py-3 px-5">Created</th>
                <th className="py-3 px-5 text-right">Details</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading && jobs.length === 0 && (
                <tr>
                  <td colSpan={9} className="py-10 text-center text-xs font-mono text-slate-400">
                    Loading executions…
                  </td>
                </tr>
              )}
              {!loading && jobs.length === 0 && (
                <tr>
                  <td colSpan={9} className="py-10 text-center text-xs font-mono text-slate-400">
                    No executions matched the current filters.
                  </td>
                </tr>
              )}
              {jobs.map((job) => (
                <tr key={job.id} className="hover:bg-slate-50/80 transition-colors">
                  <td className="py-3 px-5 font-mono text-xs font-semibold text-blue-600">
                    <div className="flex items-center space-x-1.5">
                      <span>{job.build_id}</span>
                      {job.batch_id && (
                        <span className="px-1.5 py-0.5 rounded text-[9px] font-mono bg-indigo-50 text-indigo-700 border border-indigo-200 uppercase">
                          Batch
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="py-3 px-5 font-medium text-slate-900 max-w-[200px] truncate">{job.job_name}</td>
                  <td className="py-3 px-4">
                    <span className={`inline-flex px-2 py-0.5 rounded text-[10px] font-mono font-semibold uppercase ${typeClass(job.update_type)}`}>
                      {job.update_type.replace('_', ' ')}
                    </span>
                  </td>
                  <td className="py-3 px-4">
                    <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-mono font-semibold ${statusClass(job.status)}`}>
                      {job.status}
                    </span>
                  </td>
                  <td className="py-3 px-4 text-xs text-slate-600">{job.initiated_by || 'system'}</td>
                  <td className="py-3 px-4 font-mono text-xs text-slate-700">{job.total_servers || 0} hosts</td>
                  <td className="py-3 px-4 font-mono text-xs text-slate-700 font-semibold">{formatDuration(job.duration_seconds)}</td>
                  <td className="py-3 px-5 text-xs text-slate-500 font-mono">{formatUtcDate(job.created_at)}</td>
                  <td className="py-3 px-5 text-right">
                    <button
                      onClick={() => onNavigateToBuild(job.build_id)}
                      className="inline-flex items-center gap-1 text-xs font-semibold text-blue-600 hover:text-blue-700 transition-colors"
                    >
                      View <ArrowUpRight className="w-3.5 h-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        <div className="flex items-center justify-between px-5 py-3 border-t border-slate-200 bg-slate-50/50">
          <span className="text-xs text-slate-500 font-mono">
            {loading ? 'Loading…' : `Page ${page + 1} — ${jobs.length} record${jobs.length !== 1 ? 's' : ''}`}
          </span>
          <div className="flex items-center space-x-2">
            <button
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0 || loading}
              className="flex items-center space-x-1 px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
              <span>Previous</span>
            </button>
            <span className="px-3 py-1.5 rounded-lg bg-blue-600 text-white text-xs font-mono font-bold min-w-[2rem] text-center">
              {page + 1}
            </span>
            <button
              onClick={() => setPage((p) => p + 1)}
              disabled={!hasMore || loading}
              className="flex items-center space-x-1 px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              <span>Next</span>
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
