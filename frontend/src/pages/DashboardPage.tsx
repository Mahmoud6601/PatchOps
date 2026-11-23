import React, { useEffect, useState } from 'react';
import {
  Server,
  ShieldCheck,
  ShieldAlert,
  AlertTriangle,
  RefreshCw,
  CheckCircle2,
  Zap,
  ArrowUpRight,
  Building2,
  ChevronRight,
  RotateCcw,
  TrendingUp,
  Activity,
} from 'lucide-react';
import { DashboardSummary, UpdateJob, User } from '../types';
import { api } from '../api';
import { useToast } from '../components/Toast';
import { formatUtcDate } from '../date';

interface DashboardPageProps {
  currentUser: User;
  onNavigateToBuild: (buildId: string) => void;
  onNavigateToServers: (groupId?: number | null) => void;
}

export const DashboardPage: React.FC<DashboardPageProps> = ({ currentUser, onNavigateToBuild, onNavigateToServers }) => {
  const canOperate = currentUser?.role === 'administrator' || currentUser?.role === 'operator';
  const { success, error: toastError } = useToast();
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [recentJobs, setRecentJobs] = useState<UpdateJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [allowOverlap, setAllowOverlap] = useState(false);

  const loadData = async (showSpinner = false) => {
    try {
      if (showSpinner) setLoading(true);
      const [sum, jobs] = await Promise.all([
        api.getDashboardSummary(),
        api.getJobs({ limit: 5 }),
      ]);
      setSummary(sum);
      setRecentJobs(jobs);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let initialFrame = true;
    loadData(true);
    const unsubscribe = api.subscribeSse('/stream/fleet', (eventName) => {
      if (eventName === 'fleet_update') {
        if (initialFrame) {
          initialFrame = false;
          return;
        }
        loadData(false);
      }
    });
    const fallbackInterval = setInterval(() => {
      if (typeof window !== 'undefined' && localStorage.getItem('patching_live_stream') === 'false') {
        loadData(false);
      }
    }, 15000);
    return () => {
      unsubscribe();
      clearInterval(fallbackInterval);
    };
  }, []);

  const handleQuickLaunch = async (type: 'security' | 'regular' | 'discovery') => {
    try {
      setActionLoading(true);
      const servers = await api.getServers();
      const serverIds = servers.filter((s) => s.is_managed).map((s) => s.id);
      if (serverIds.length === 0) {
        toastError('No Endpoints', 'No managed endpoints available in inventory.');
        return;
      }
      const job = await api.launchJob({
        job_name:
          type === 'discovery'
            ? 'Fleet Inventory Discovery'
            : type === 'security'
            ? 'Security Patch Rollout'
            : 'Regular Update Deployment',
        update_type: type,
        server_ids: serverIds,
        allow_overlap: currentUser.role === 'administrator' && allowOverlap,
      });
      onNavigateToBuild(job.build_id);
    } catch (e: any) {
      toastError('Launch Failed', e.message || 'Error launching job');
    } finally {
      setActionLoading(false);
      setAllowOverlap(false);
    }
  };

  // Compute fleet compliance %
  const complianceRate =
    summary && summary.total_servers > 0
      ? Math.round(
          ((summary.total_servers - (summary.servers_requiring_updates || 0)) /
            summary.total_servers) *
            100
        )
      : 100;

  // Job success rate
  const totalFinishedJobs = (summary?.successful_jobs || 0) + (summary?.failed_jobs || 0);
  const jobSuccessRate =
    totalFinishedJobs > 0
      ? Math.round(((summary?.successful_jobs || 0) / totalFinishedJobs) * 100)
      : 100;

  if (loading && !summary) {
    return (
      <div className="flex items-center justify-center h-96">
        <RefreshCw className="w-8 h-8 text-blue-600 animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Top Banner & Quick Actions */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 p-5 rounded-2xl bg-gradient-to-r from-blue-600 to-indigo-700 shadow-lg shadow-blue-600/20">
        <div>
          <h2 className="text-lg font-bold text-white tracking-tight">Endpoint Management Overview</h2>
          <p className="text-sm text-blue-200 mt-0.5">Real-time posture, pending updates, and active automation runs.</p>
        </div>
        {canOperate && (
          <div className="flex flex-wrap items-center gap-2">
            {currentUser.role === 'administrator' && (
              <label className="flex items-center gap-2 text-xs text-blue-100 font-medium bg-white/10 px-3 py-1.5 rounded-lg border border-white/20">
                <input
                  type="checkbox"
                  checked={allowOverlap}
                  onChange={(e) => setAllowOverlap(e.target.checked)}
                  className="rounded border-blue-300 text-blue-600 focus:ring-blue-500"
                />
                Allow overlap
              </label>
            )}
            <button
              onClick={() => handleQuickLaunch('discovery')}
              disabled={actionLoading || !summary?.total_servers}
              className="flex items-center space-x-2 px-3.5 py-2 rounded-lg bg-white/15 hover:bg-white/25 text-white font-medium text-xs border border-white/20 transition-all disabled:opacity-50"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>Run Discovery</span>
            </button>
            <button
              onClick={() => handleQuickLaunch('security')}
              disabled={actionLoading}
              className="flex items-center space-x-2 px-3.5 py-2 rounded-lg bg-white text-blue-700 hover:bg-blue-50 font-semibold text-xs shadow-sm transition-all disabled:opacity-50"
            >
              <ShieldCheck className="w-3.5 h-3.5" />
              <span>Deploy Security Patches</span>
            </button>
            <button
              onClick={() => handleQuickLaunch('regular')}
              disabled={actionLoading}
              className="flex items-center space-x-2 px-3.5 py-2 rounded-lg bg-white/15 hover:bg-white/25 text-white font-medium text-xs border border-white/20 transition-all disabled:opacity-50"
            >
              <Zap className="w-3.5 h-3.5 text-amber-300" />
              <span>Deploy Updates</span>
            </button>
          </div>
        )}
      </div>

      {/* Reboot Alert Banner */}
      {summary && summary.servers_requiring_reboot > 0 && (
        <div className="p-4 rounded-xl bg-amber-50 border border-amber-200 text-amber-900 flex items-center justify-between shadow-xs">
          <div className="flex items-center space-x-3">
            <AlertTriangle className="w-5 h-5 text-amber-500 animate-pulse" />
            <span className="text-sm font-medium">
              {summary.servers_requiring_reboot} endpoint(s) require a reboot to finalize updates.
            </span>
          </div>
          <button
            onClick={() => onNavigateToServers()}
            className="text-xs px-3.5 py-1.5 rounded-lg bg-amber-100 hover:bg-amber-200 text-amber-900 border border-amber-300 font-semibold transition-colors"
          >
            Inspect Endpoints
          </button>
        </div>
      )}

      {/* KPI Metric Cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        {/* Managed Endpoints */}
        <div className="col-span-1 md:col-span-1 p-4 rounded-xl bg-white border border-slate-200 shadow-xs hover:shadow-sm transition-shadow">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] font-bold tracking-widest text-slate-400 uppercase font-mono">Endpoints</span>
            <Server className="w-4 h-4 text-blue-500" />
          </div>
          <div className="text-2xl font-bold text-slate-900">{summary?.total_servers ?? '—'}</div>
          <div className="flex items-center space-x-2 text-[11px] text-slate-500 mt-1 font-mono">
            <span className="text-emerald-600 font-semibold flex items-center">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 mr-1 animate-pulse" />
              {summary?.online_servers} on
            </span>
            <span>·</span>
            <span className="text-rose-500 font-semibold">{summary?.offline_servers} off</span>
          </div>
        </div>

        {/* Fleet Compliance */}
        <div className="col-span-1 md:col-span-1 p-4 rounded-xl bg-white border border-slate-200 shadow-xs hover:shadow-sm transition-shadow">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] font-bold tracking-widest text-slate-400 uppercase font-mono">Compliance</span>
            <TrendingUp className="w-4 h-4 text-emerald-500" />
          </div>
          <div className={`text-2xl font-bold ${complianceRate >= 90 ? 'text-emerald-600' : complianceRate >= 70 ? 'text-amber-600' : 'text-rose-600'}`}>
            {complianceRate}%
          </div>
          <div className="mt-2 w-full bg-slate-100 rounded-full h-1.5 overflow-hidden">
            <div
              className={`h-1.5 rounded-full transition-all duration-500 ${complianceRate >= 90 ? 'bg-emerald-500' : complianceRate >= 70 ? 'bg-amber-500' : 'bg-rose-500'}`}
              style={{ width: `${complianceRate}%` }}
            />
          </div>
        </div>

        {/* Needs Patching */}
        <div className="col-span-1 md:col-span-1 p-4 rounded-xl bg-white border border-slate-200 shadow-xs hover:shadow-sm transition-shadow">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] font-bold tracking-widest text-slate-400 uppercase font-mono">Needs Patch</span>
            <ShieldAlert className="w-4 h-4 text-amber-500" />
          </div>
          <div className="text-2xl font-bold text-amber-600">{summary?.servers_requiring_updates ?? '—'}</div>
          <div className="text-[11px] text-rose-500 font-mono font-semibold mt-1">
            {summary?.security_updates_available} critical
          </div>
        </div>

        {/* Reboot Required */}
        <div className="col-span-1 md:col-span-1 p-4 rounded-xl bg-white border border-slate-200 shadow-xs hover:shadow-sm transition-shadow">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] font-bold tracking-widest text-slate-400 uppercase font-mono">Reboots</span>
            <RotateCcw className={`w-4 h-4 ${(summary?.servers_requiring_reboot || 0) > 0 ? 'text-amber-500 animate-spin' : 'text-slate-400'}`} />
          </div>
          <div className={`text-2xl font-bold ${(summary?.servers_requiring_reboot || 0) > 0 ? 'text-amber-600' : 'text-slate-400'}`}>
            {summary?.servers_requiring_reboot ?? '—'}
          </div>
          <div className="text-[11px] text-slate-400 font-mono mt-1">endpoints pending</div>
        </div>

        {/* Active Runs */}
        <div className="col-span-1 md:col-span-1 p-4 rounded-xl bg-white border border-slate-200 shadow-xs hover:shadow-sm transition-shadow">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] font-bold tracking-widest text-slate-400 uppercase font-mono">Active Runs</span>
            <Activity className={`w-4 h-4 ${(summary?.running_jobs || 0) > 0 ? 'text-blue-500 animate-pulse' : 'text-slate-400'}`} />
          </div>
          <div className={`text-2xl font-bold ${(summary?.running_jobs || 0) > 0 ? 'text-blue-600' : 'text-slate-400'}`}>
            {summary?.running_jobs ?? '—'}
          </div>
          <div className="text-[11px] text-slate-400 font-mono mt-1">{summary?.pending_jobs} queued</div>
        </div>

        {/* Success Rate */}
        <div className="col-span-1 md:col-span-1 p-4 rounded-xl bg-white border border-slate-200 shadow-xs hover:shadow-sm transition-shadow">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] font-bold tracking-widest text-slate-400 uppercase font-mono">Success Rate</span>
            <CheckCircle2 className="w-4 h-4 text-emerald-500" />
          </div>
          <div className="text-2xl font-bold text-emerald-600">{jobSuccessRate}%</div>
          <div className="text-[11px] text-slate-400 font-mono mt-1">
            {summary?.successful_jobs} ok · <span className="text-rose-400">{summary?.failed_jobs} failed</span>
          </div>
        </div>
      </div>

      {/* Customer Fleet Overview */}
      <div className="rounded-xl border border-slate-200 bg-white overflow-hidden shadow-sm">
        <div className="p-4 border-b border-slate-100 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 bg-gradient-to-r from-indigo-50/40 via-white to-blue-50/30">
          <div className="flex items-center space-x-3">
            <div className="p-2 rounded-lg bg-indigo-100 text-indigo-600">
              <Building2 className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-slate-900">Customer Fleet Overview</h3>
              <p className="text-xs text-slate-400">Live compliance and node health per customer tenant</p>
            </div>
          </div>
          <button
            onClick={() => onNavigateToServers(null)}
            className="text-xs font-semibold text-indigo-600 hover:text-indigo-800 flex items-center space-x-1 transition-colors"
          >
            <span>Manage All Endpoints</span>
            <ChevronRight className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="p-4">
          {!summary?.customer_summaries || summary.customer_summaries.length === 0 ? (
            <div className="text-center py-8 text-slate-400 text-xs font-mono">
              No customer organizations created yet. Add customers in the Endpoints tab.
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {summary.customer_summaries.map((c, idx) => {
                const isHealthy = c.health_status === 'healthy';
                const isCritical = c.health_status === 'critical';
                return (
                  <div
                    key={c.id || `unassigned-${idx}`}
                    className={`rounded-xl border p-4 transition-all duration-300 hover:shadow-2xl hover:shadow-indigo-300/50 hover:-translate-y-1.5 ${
                      isCritical
                        ? 'border-rose-200 bg-gradient-to-br from-rose-50/50 to-white'
                        : !isHealthy
                        ? 'border-amber-200 bg-gradient-to-br from-amber-50/40 to-white'
                        : 'border-slate-200 bg-gradient-to-br from-white to-indigo-50/20 hover:border-indigo-300'
                    }`}
                    style={{ animationDelay: `${idx * 80}ms`, animation: 'scaleIn 0.3s ease-out both' }}
                  >
                    {/* Customer Header */}
                    <div className="flex items-start justify-between gap-2 mb-3">
                      <div className="flex items-center space-x-2 min-w-0">
                        <div className={`p-2 rounded-lg ${isCritical ? 'bg-rose-100 text-rose-700' : !isHealthy ? 'bg-amber-100 text-amber-700' : 'bg-indigo-100 text-indigo-700'}`}>
                          <Building2 className="w-4 h-4" />
                        </div>
                        <div className="min-w-0">
                          <h4 className="text-sm font-bold text-slate-900 truncate">{c.name}</h4>
                          <p className="text-[11px] text-slate-500 truncate">{c.description || 'Enterprise Tenant'}</p>
                        </div>
                      </div>
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide shrink-0 ${
                        isHealthy
                          ? 'bg-emerald-100 text-emerald-800 border border-emerald-200'
                          : isCritical
                          ? 'bg-rose-100 text-rose-800 border border-rose-200'
                          : 'bg-amber-100 text-amber-800 border border-amber-200'
                      }`}>
                        {isHealthy ? 'Compliant' : isCritical ? 'Critical' : 'Warning'}
                      </span>
                    </div>

                    {/* Compliance bar */}
                    <div className="mb-3">
                      <div className="flex items-center justify-between text-[11px] font-mono mb-1">
                        <span className="text-slate-500">Patch Compliance</span>
                        <span className={`font-bold ${c.compliance_rate >= 100 ? 'text-emerald-600' : c.compliance_rate >= 70 ? 'text-amber-600' : 'text-rose-600'}`}>
                          {c.compliance_rate}%
                        </span>
                      </div>
                      <div className="w-full bg-slate-100 rounded-full h-2 overflow-hidden">
                        <div
                          className={`h-2 rounded-full transition-all duration-1000 ease-out ${c.compliance_rate >= 100 ? 'bg-gradient-to-r from-emerald-400 to-emerald-600' : c.compliance_rate >= 70 ? 'bg-gradient-to-r from-amber-400 to-amber-600' : 'bg-gradient-to-r from-rose-400 to-rose-600'}`}
                          style={{ width: `${Math.min(100, Math.max(0, c.compliance_rate))}%` }}
                        />
                      </div>
                    </div>

                    {/* Key Metrics */}
                    <div className="grid grid-cols-2 gap-2 text-xs mb-3">
                      <div className="p-2.5 rounded-lg bg-slate-50/80 border border-slate-100 hover:bg-indigo-50/40 hover:border-indigo-200/50 hover:shadow-sm transition-all duration-200">
                        <div className="text-[10px] text-slate-400 font-medium">Nodes</div>
                        <div className="font-bold text-slate-800 mt-0.5">
                          {c.total_servers}
                          <span className="text-[10px] text-slate-400 font-normal ml-1">({c.windows_servers}W/{c.linux_servers}L)</span>
                        </div>
                      </div>
                      <div className="p-2.5 rounded-lg bg-slate-50/80 border border-slate-100 hover:bg-indigo-50/40 hover:border-indigo-200/50 hover:shadow-sm transition-all duration-200">
                        <div className="text-[10px] text-slate-400 font-medium">Status</div>
                        <div className="font-bold mt-0.5">
                          <span className="text-emerald-600">{c.online_servers} on</span>
                          {c.offline_servers > 0 && <span className="text-rose-500 ml-1 font-normal text-[11px]">· {c.offline_servers} off</span>}
                        </div>
                      </div>
                      <div className="p-2.5 rounded-lg bg-slate-50/80 border border-slate-100 hover:bg-indigo-50/40 hover:border-indigo-200/50 hover:shadow-sm transition-all duration-200">
                        <div className="text-[10px] text-slate-400 font-medium">Pending</div>
                        <div className="font-bold mt-0.5">
                          {c.pending_updates_count > 0 ? (
                            <span className="text-amber-700">
                              {c.pending_updates_count}
                              {c.security_updates_count > 0 && <span className="text-rose-500 text-[10px] ml-1">({c.security_updates_count} sec)</span>}
                            </span>
                          ) : (
                            <span className="text-emerald-600">Up to date</span>
                          )}
                        </div>
                      </div>
                      <div className="p-2.5 rounded-lg bg-slate-50/80 border border-slate-100 hover:bg-indigo-50/40 hover:border-indigo-200/50 hover:shadow-sm transition-all duration-200">
                        <div className="text-[10px] text-slate-400 font-medium">Reboot</div>
                        <div className="font-bold mt-0.5">
                          {c.reboot_required_count > 0 ? (
                            <span className="text-amber-600 flex items-center space-x-1">
                              <RotateCcw className="w-3 h-3 animate-spin" />
                              <span>{c.reboot_required_count}</span>
                            </span>
                          ) : (
                            <span className="text-emerald-600">None</span>
                          )}
                        </div>
                      </div>
                    </div>

                    <button
                      onClick={() => onNavigateToServers(c.id ?? null)}
                      className="w-full py-2 px-3 rounded-lg text-xs font-semibold text-indigo-700 bg-indigo-50/80 hover:bg-indigo-100 border border-indigo-200/50 hover:border-indigo-300 transition-all duration-200 flex items-center justify-center space-x-1 hover:shadow-sm"
                    >
                      <span>View {c.name} Endpoints</span>
                      <ArrowUpRight className="w-3.5 h-3.5" />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Recent Execution History */}
      <div className="rounded-xl border border-slate-200 bg-white overflow-hidden shadow-xs">
        <div className="p-4 border-b border-slate-200 flex items-center justify-between bg-slate-50/50">
          <h3 className="text-sm font-semibold text-slate-800 tracking-wide uppercase font-mono flex items-center space-x-2">
            <Activity className="w-4 h-4 text-blue-500" />
            <span>Recent Execution History</span>
          </h3>
          <span className="text-xs text-slate-400 font-mono">Auto-refresh every 5s</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-slate-500 text-[11px] font-mono uppercase border-b border-slate-200">
              <tr>
                <th className="py-3 px-5">Run ID</th>
                <th className="py-3 px-5">Job Name</th>
                <th className="py-3 px-5">Type</th>
                <th className="py-3 px-5">Status</th>
                <th className="py-3 px-5">Endpoints</th>
                <th className="py-3 px-5">Duration</th>
                <th className="py-3 px-5 text-right">Details</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {recentJobs.length === 0 ? (
                <tr>
                  <td colSpan={7} className="text-center py-10 text-slate-400 text-xs font-mono">
                    No executions yet. Launch a job to get started.
                  </td>
                </tr>
              ) : (
                recentJobs.map((j) => (
                  <tr key={j.id} className="hover:bg-slate-50/80 transition-colors">
                    <td className="py-3 px-5 font-mono font-semibold text-blue-600 text-xs">
                      {j.build_id}
                    </td>
                    <td className="py-3 px-5 font-medium text-slate-900 text-sm">{j.job_name}</td>
                    <td className="py-3 px-5">
                      <span className="px-2 py-0.5 rounded text-[10px] font-mono font-semibold bg-slate-100 text-slate-700 border border-slate-200 uppercase">
                        {j.update_type}
                      </span>
                    </td>
                    <td className="py-3 px-5">
                      <span className={`px-2.5 py-0.5 rounded-full text-xs font-mono font-semibold ${
                        j.status === 'success'
                          ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                          : j.status === 'running'
                          ? 'bg-blue-50 text-blue-700 border border-blue-200 animate-pulse'
                          : j.status === 'pending'
                          ? 'bg-amber-50 text-amber-700 border border-amber-200'
                          : 'bg-rose-50 text-rose-700 border border-rose-200'
                      }`}>
                        {j.status}
                      </span>
                    </td>
                    <td className="py-3 px-5 font-mono text-xs text-slate-600">{j.total_servers || 0} nodes</td>
                    <td className="py-3 px-5 font-mono text-xs text-slate-600">{j.duration_seconds}s</td>
                    <td className="py-3 px-5 text-right">
                      <button
                        onClick={() => onNavigateToBuild(j.build_id)}
                        className="inline-flex items-center space-x-1 text-xs font-semibold text-blue-600 hover:text-blue-700 transition-colors"
                      >
                        <span>Open</span>
                        <ArrowUpRight className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
