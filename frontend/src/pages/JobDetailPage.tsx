import React, { useEffect, useState } from 'react';
import { ArrowLeft, RefreshCw, XCircle, Layers, RotateCcw, ShieldCheck, Share2, Download, Radio } from 'lucide-react';
import { InstalledPatch, UpdateJob, User } from '../types';
import { api } from '../api';
import { useToast } from '../components/Toast';
import { ConfirmModal } from '../components/ConfirmModal';
import { StageMatrix } from '../components/StageMatrix';
import { formatUtcDate, parseUtcDate, formatDuration } from '../date';

interface JobDetailPageProps {
  buildId: string;
  currentUser: User;
  onBack: () => void;
  onNavigateToBuild?: (buildId: string) => void;
}

export const JobDetailPage: React.FC<JobDetailPageProps> = ({ buildId, currentUser, onBack, onNavigateToBuild }) => {
  const { success, error: toastError } = useToast();
  const [job, setJob] = useState<UpdateJob | null>(null);
  const [installedPatches, setInstalledPatches] = useState<InstalledPatch[]>([]);
  const [loading, setLoading] = useState(true);
  const [cancelling, setCancelling] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [selectedPartition, setSelectedPartition] = useState<string>('all');

  // Confirm modal state
  const [confirmModal, setConfirmModal] = useState<{
    open: boolean;
    title: string;
    message: string;
    confirmLabel: string;
    variant: 'danger' | 'warning' | 'info';
    onConfirm: () => void;
  }>({ open: false, title: '', message: '', confirmLabel: 'Confirm', variant: 'danger', onConfirm: () => {} });

  const closeConfirm = () => setConfirmModal((prev) => ({ ...prev, open: false }));

  const showConfirm = (
    title: string,
    message: string,
    confirmLabel: string,
    variant: 'danger' | 'warning' | 'info',
    onConfirm: () => void
  ) => {
    setConfirmModal({ open: true, title, message, confirmLabel, variant, onConfirm });
  };

  const [now, setNow] = useState(() => Date.now());
  const [sseConnected, setSseConnected] = useState(false);

  const fetchJob = async () => {
    try {
      const [data, patches] = await Promise.all([
        api.getJob(buildId),
        api.getJobPatches(buildId).catch(() => [] as InstalledPatch[]),
      ]);
      setJob(data);
      setInstalledPatches(patches);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setSelectedPartition('all');
    setLoading(true);
    fetchJob();

    const unsubscribe = api.subscribeSse(
      `/stream/jobs/${encodeURIComponent(buildId)}`,
      (eventName, payload) => {
        if (eventName === 'job_update' && payload?.job) {
          setJob(payload.job);
          if (Array.isArray(payload.patches)) {
            setInstalledPatches(payload.patches);
          }
          setLoading(false);
        }
      },
      (connected) => setSseConnected(connected)
    );

    // Fallback safety sync only if SSE is disabled/disconnected
    const fallbackInterval = setInterval(() => {
      if (typeof window !== 'undefined' && localStorage.getItem('patching_live_stream') === 'false') {
        fetchJob();
      }
    }, 10000);

    return () => {
      unsubscribe();
      clearInterval(fallbackInterval);
    };
  }, [buildId]);

  const handleCopyShareLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      success('Run Link Copied', 'Direct URL copied to clipboard.');
    } catch {
      toastError('Copy Failed', 'Could not copy link to clipboard');
    }
  };

  const handleExportRunCsv = async () => {
    try {
      await api.downloadJobCsv(buildId);
    } catch (err: any) {
      toastError('Export Failed', err.message || 'Could not export run CSV');
    }
  };

  useEffect(() => {
    if (job?.status !== 'running') return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [job?.status]);

  const handleRetryFailed = async (allBatch = false) => {
    showConfirm(
      allBatch ? 'Retry All Failed (Batch)' : 'Retry Failed Hosts',
      allBatch
        ? 'Launch a new batch job to retry all failed servers across the batch?'
        : 'Launch a new job to retry only the failed host(s) from this build?',
      'Retry',
      'warning',
      async () => {
        closeConfirm();
        try {
          setRetrying(true);
          const newJob = await api.retryFailedHosts(buildId, allBatch);
          success('Retry Queued', `New run: ${newJob.build_id}`);
          if (onNavigateToBuild) {
            onNavigateToBuild(newJob.build_id);
          } else {
            await fetchJob();
          }
        } catch (err: any) {
          toastError('Retry Failed', err.message || 'Failed to trigger retry job');
        } finally {
          setRetrying(false);
        }
      }
    );
  };

  const handleCancel = async () => {
    showConfirm(
      'Cancel Run',
      'Are you sure you want to cancel this run? This cannot be undone.',
      'Cancel Run',
      'danger',
      async () => {
        closeConfirm();
        try {
          setCancelling(true);
          await api.cancelJob(buildId);
          await fetchJob();
        } catch (e: any) {
          toastError('Cancel Failed', e.message || 'Error cancelling job');
        } finally {
          setCancelling(false);
        }
      }
    );
  };

  if (loading && !job) {
    return (
      <div className="flex items-center justify-center h-96">
        <RefreshCw className="w-8 h-8 text-blue-600 animate-spin" />
      </div>
    );
  }

  if (!job) {
    return (
      <div className="text-center py-12">
        <p className="text-slate-500 font-mono">Job not found.</p>
        <button onClick={onBack} className="mt-4 px-4 py-2 rounded-lg bg-slate-100 border border-slate-300 text-slate-700 font-medium">Go Back</button>
      </div>
    );
  }

  const liveDurationSeconds = (() => {
    if (job.status !== 'running' || !job.start_time) return job.duration_seconds;
    const started = parseUtcDate(job.start_time);
    if (!started) return job.duration_seconds;
    return Math.max(job.duration_seconds, Math.floor((now - started.getTime()) / 1000));
  })();

  const allBatchServers = (job.batch_server_records && job.batch_server_records.length > 0)
    ? job.batch_server_records
    : (job.server_records || []);

  const displayedServers = (() => {
    if (selectedPartition === 'all') {
      return allBatchServers;
    }
    const sister = job.batch_sister_jobs?.find((s) => s.build_id === selectedPartition);
    if (sister) {
      return allBatchServers.filter((s) => s.job_id === sister.id);
    }
    return job.server_records || [];
  })();

  return (
    <div className="space-y-6">
      {/* Confirm Modal */}
      <ConfirmModal
        isOpen={confirmModal.open}
        title={confirmModal.title}
        message={confirmModal.message}
        confirmLabel={confirmModal.confirmLabel}
        variant={confirmModal.variant}
        onConfirm={confirmModal.onConfirm}
        onCancel={closeConfirm}
      />

      {/* Navigation & Header */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 border-b border-slate-200 pb-5">
        <div className="flex items-center space-x-4">
          <button
            onClick={onBack}
            className="p-2 rounded-lg bg-white hover:bg-slate-50 border border-slate-300 text-slate-700 shadow-xs transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <div>
            <div className="flex items-center space-x-3">
              <h2 className="text-xl font-bold text-slate-900 font-mono">{job.build_id}</h2>
              <span className={`text-xs px-2.5 py-1 rounded-full font-medium font-mono ${
                job.status === 'success'
                  ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                  : job.status === 'running'
                  ? 'bg-blue-50 text-blue-700 border border-blue-200 animate-pulse'
                  : job.status === 'pending'
                  ? 'bg-amber-50 text-amber-700 border border-amber-200 animate-pulse'
                  : 'bg-rose-50 text-rose-700 border border-rose-200'
              }`}>
                {job.status.toUpperCase()}
              </span>
              {sseConnected && (
                <span className="inline-flex items-center space-x-1 px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 text-[10px] font-mono font-semibold">
                  <Radio className="w-3 h-3 animate-pulse" />
                  <span>SSE Live</span>
                </span>
              )}
            </div>
            <p className="text-xs text-slate-500 mt-1">
              Workflow: <span className="text-slate-800 font-semibold">{job.job_name}</span> • Type: <span className="font-mono text-blue-600 uppercase font-medium">{job.update_type}</span>
            </p>
          </div>
        </div>

        <div className="flex items-center space-x-3">
          {/* Retry Failed Hosts Only */}
          {job.failed_servers > 0 && (currentUser.role === "administrator" || currentUser.role === "operator") && (
            <button
              onClick={() => handleRetryFailed(false)}
              disabled={retrying}
              className="flex items-center space-x-1.5 px-3.5 py-2 rounded-lg bg-amber-50 hover:bg-amber-100 text-amber-800 border border-amber-300 text-xs font-semibold shadow-xs transition-all disabled:opacity-50"
              title="Launch a new job targeting ONLY the servers that failed in this build"
            >
              <RotateCcw className={`w-3.5 h-3.5 text-amber-700 ${retrying ? "animate-spin" : ""}`} />
              <span>Retry Failed Hosts ({job.failed_servers})</span>
            </button>
          )}
          {job.batch_failed_servers && job.batch_failed_servers > job.failed_servers && (currentUser.role === "administrator" || currentUser.role === "operator") && (
            <button
              onClick={() => handleRetryFailed(true)}
              disabled={retrying}
              className="flex items-center space-x-1.5 px-3 py-2 rounded-lg bg-orange-50 hover:bg-orange-100 text-orange-800 border border-orange-300 text-xs font-semibold shadow-xs transition-all disabled:opacity-50"
              title="Retry all failed servers across the entire batch"
            >
              <RotateCcw className={`w-3.5 h-3.5 text-orange-700 ${retrying ? "animate-spin" : ""}`} />
              <span>Retry All Batch ({job.batch_failed_servers})</span>
            </button>
          )}
          {job.status === 'running' && currentUser.role === 'administrator' && (
            <button
              onClick={handleCancel}
              disabled={cancelling}
              className="flex items-center space-x-1.5 px-3.5 py-2 rounded-lg bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 text-xs font-semibold shadow-xs transition-all disabled:opacity-50"
            >
              <XCircle className="w-4 h-4" />
              <span>Cancel Run</span>
            </button>
          )}
          <button
            onClick={handleCopyShareLink}
            title="Copy direct shareable URL for this run"
            className="inline-flex items-center space-x-1.5 px-3 py-2 rounded-lg bg-white hover:bg-slate-50 border border-slate-300 text-slate-700 text-xs font-medium shadow-xs transition-colors"
          >
            <Share2 className="w-3.5 h-3.5 text-blue-600" />
            <span>Share URL</span>
          </button>
          <button
            onClick={handleExportRunCsv}
            title="Export per-host stage execution CSV"
            className="inline-flex items-center space-x-1.5 px-3 py-2 rounded-lg bg-white hover:bg-slate-50 border border-slate-300 text-slate-700 text-xs font-medium shadow-xs transition-colors"
          >
            <Download className="w-3.5 h-3.5 text-slate-600" />
            <span>Export CSV</span>
          </button>
          <button
            onClick={fetchJob}
            title="Manual refresh"
            className="p-2 rounded-lg bg-white hover:bg-slate-50 border border-slate-300 text-slate-600 shadow-xs transition-colors"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Action1 Style: Unified Batch Execution Banner */}
      {job.batch_sister_jobs && job.batch_sister_jobs.length > 1 && (
        <div className="rounded-xl bg-slate-800 border border-slate-700 p-4">
          <div className="flex items-center space-x-2 mb-3">
            <Layers className="w-4 h-4 text-indigo-400" />
            <span className="text-xs font-semibold text-white font-mono uppercase tracking-wide">Batch Execution View</span>
            <span className="text-xs text-slate-400 font-mono">— {job.batch_count} parallel sub-jobs</span>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => setSelectedPartition('all')}
              className={`flex items-center space-x-2 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                selectedPartition === 'all'
                  ? 'bg-white text-slate-900 shadow-sm font-semibold ring-2 ring-indigo-400 ring-offset-2 ring-offset-slate-900'
                  : 'bg-white/10 hover:bg-white/20 text-white border border-white/15'
              }`}
            >
              <Layers className="w-3.5 h-3.5 text-indigo-400" />
              <span>All Fleet Nodes ({job.batch_total_servers ?? allBatchServers.length})</span>
            </button>
            {job.batch_sister_jobs.map((sister) => {
              const isSelected = selectedPartition === sister.build_id;
              return (
                <button
                  key={sister.build_id}
                  onClick={() => setSelectedPartition(sister.build_id)}
                  className={`flex items-center space-x-2 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                    isSelected
                      ? 'bg-white text-slate-900 shadow-sm font-semibold ring-2 ring-indigo-400 ring-offset-2 ring-offset-slate-900'
                      : 'bg-white/10 hover:bg-white/20 text-white border border-white/15'
                  }`}
                >
                  <span className="font-mono">{sister.build_id}</span>
                  <span className="text-[11px] opacity-75 truncate max-w-[200px]">
                    {sister.job_name.includes(' • ') ? sister.job_name.split(' • ')[1] : sister.job_name}
                  </span>
                  <span className={`px-1.5 py-0.5 rounded text-[10px] font-mono uppercase ${
                    sister.status === 'success'
                      ? 'bg-emerald-500/20 text-emerald-300'
                      : sister.status === 'running'
                      ? 'bg-blue-400/20 text-blue-200 font-bold'
                      : sister.status === 'failed'
                      ? 'bg-rose-500/20 text-rose-300'
                      : 'bg-amber-400/20 text-amber-200'
                  }`}>
                    {sister.status}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Metric & Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="p-4 rounded-xl bg-white border border-slate-200 shadow-sm">
          <div className="text-slate-500 text-xs font-mono uppercase font-semibold">Total Duration</div>
          <div className="text-xl font-bold font-mono text-slate-900 mt-1">{formatDuration(liveDurationSeconds)}</div>
        </div>
        <div className="p-4 rounded-xl bg-white border border-slate-200 shadow-sm">
          <div className="text-slate-500 text-xs font-mono uppercase font-semibold">Target Nodes</div>
          <div className="text-xl font-bold font-mono text-blue-600 mt-1">
            {selectedPartition === 'all' && (job.batch_total_servers || allBatchServers.length)
              ? `${job.batch_total_servers || allBatchServers.length} Servers (All Fleet)`
              : `${displayedServers.length} Servers`}
          </div>
        </div>
        <div className="p-4 rounded-xl bg-white border border-slate-200 shadow-sm">
          <div className="text-slate-500 text-xs font-mono uppercase font-semibold">Initiated By</div>
          <div className="text-xl font-bold font-mono text-slate-800 mt-1">{job.initiated_by || 'system'}</div>
        </div>
        <div className="p-4 rounded-xl bg-white border border-slate-200 shadow-sm">
          <div className="text-slate-500 text-xs font-mono uppercase font-semibold">AWX Job Reference</div>
          <div className="text-xl font-bold font-mono text-indigo-600 mt-1">
            {job.awx_job_id ? `#${job.awx_job_id}` : 'Local Queue'}
          </div>
        </div>
      </div>

      {/* Error Banner */}
      {job.error_summary && (
        <div className="p-4 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 text-xs font-mono shadow-xs">
          <div className="font-bold text-sm mb-1 text-rose-900">Execution Error Encountered</div>
          <div>{job.error_summary}</div>
        </div>
      )}

      {/* Multi-Node Stage Execution Matrix */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-slate-800 tracking-wide uppercase font-mono">
            Execution Timeline
          </h3>
          <span className="text-xs text-slate-500 font-mono">
            {selectedPartition === 'all' && (job.batch_count || 1) > 1
              ? `Unified Batch View (${displayedServers.length} Nodes)`
              : 'Real-time Node Telemetry'}
          </span>
        </div>
        <StageMatrix
          servers={displayedServers}
          jobStatus={job.status}
          updateType={job.update_type}
          rebootOnly={job.reboot_only}
          cleanCacheOnly={job.clean_cache_only}
          now={now}
        />
      </div>

      {/* Installed Packages & KBs Recorded During This Run */}
      {installedPatches.length > 0 && (
        <div className="rounded-xl border border-slate-200 bg-white overflow-hidden shadow-sm">
          <div className="px-5 py-3.5 border-b border-slate-100 bg-slate-50/60 flex items-center justify-between">
            <div className="flex items-center space-x-2">
              <ShieldCheck className="w-4 h-4 text-emerald-600" />
              <h3 className="text-xs font-bold uppercase tracking-wider text-slate-700 font-mono">
                Installed Packages &amp; KBs ({installedPatches.length})
              </h3>
            </div>
            <span className="text-[11px] text-slate-400 font-mono">Captured from AWX Update Stage</span>
          </div>
          <div className="max-h-64 overflow-y-auto divide-y divide-slate-100">
            {installedPatches.map((p) => (
              <div key={p.id} className="px-5 py-2.5 flex items-center justify-between gap-4 text-xs hover:bg-slate-50/70">
                <div className="flex items-center space-x-3 min-w-0">
                  <span className="px-2 py-0.5 rounded bg-slate-100 text-slate-700 font-mono text-[11px] shrink-0">
                    {p.server_hostname || `Host #${p.server_id}`}
                  </span>
                  <span className="font-mono font-semibold text-slate-900 truncate" title={p.package_or_kb}>
                    {p.package_or_kb}
                  </span>
                </div>
                <div className="flex items-center space-x-3 shrink-0">
                  <span
                    className={`px-2 py-0.5 rounded text-[10px] font-mono uppercase font-semibold border ${
                      p.patch_type === 'security'
                        ? 'bg-rose-50 text-rose-700 border-rose-200'
                        : 'bg-blue-50 text-blue-700 border-blue-200'
                    }`}
                  >
                    {p.patch_type}
                  </span>
                  <span className="text-[11px] text-slate-400 font-mono">{formatUtcDate(p.installed_at)}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
