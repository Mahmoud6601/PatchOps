import React, { useState, useEffect } from 'react';
import {
  CheckCircle2,
  Clock,
  XCircle,
  AlertTriangle,
  RefreshCw,
  Ban,
  Terminal,
  X,
  FileText,
  Server as ServerIcon,
  Copy,
  Check,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { JobServer, JobStatus, StageStatus, PipelineStage, UpdateType } from '../types';
import { parseUtcDate, formatDuration } from '../date';

/* ─── Props ──────────────────────────────────────────────────────────── */

interface StageMatrixProps {
  servers: JobServer[];
  jobStatus: JobStatus;
  updateType: UpdateType;
  rebootOnly?: boolean;
  cleanCacheOnly?: boolean;
  now: number;
  onSelectServer?: (server: JobServer) => void;
}

const ALL_STAGES = ['Discovery', 'Pre-check', 'Update', 'Reboot', 'Verification'];

/* ─── Log line parser ────────────────────────────────────────────────── */

type LogLineType = 'success' | 'failed' | 'skipped' | 'warning' | 'info' | 'changed';

function classifyLine(line: string): LogLineType {
  const up = line.trim().toUpperCase();
  if (up.startsWith('SUCCESS') || up.includes(' OK')) return 'success';
  if (up.startsWith('FAILED') || up.startsWith('ERROR') || up.startsWith('FATAL')) return 'failed';
  if (up.startsWith('SKIPPED') || up.startsWith('SKIP')) return 'skipped';
  if (up.startsWith('CHANGED') || up.startsWith('CHANGE')) return 'changed';
  if (up.startsWith('WARNING') || up.startsWith('WARN')) return 'warning';
  return 'info';
}

const LINE_COLORS: Record<LogLineType, string> = {
  success: 'text-emerald-600',
  failed:  'text-rose-600',
  skipped: 'text-slate-400',
  warning: 'text-amber-600',
  changed: 'text-blue-600',
  info:    'text-slate-500',
};
const LINE_DOT: Record<LogLineType, string> = {
  success: 'bg-emerald-500',
  failed:  'bg-rose-500',
  skipped: 'bg-slate-300',
  warning: 'bg-amber-500',
  changed: 'bg-blue-500',
  info:    'bg-slate-300',
};

function LogLine({ line, idx }: { line: string; idx: number }) {
  const type = classifyLine(line);
  return (
    <div className="flex items-start space-x-2.5 py-1 group">
      <span className="text-[10px] text-slate-300 font-mono w-5 text-right shrink-0 select-none pt-0.5">
        {idx + 1}
      </span>
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 mt-1.5 ${LINE_DOT[type]}`} />
      <span className={`text-[12px] font-mono leading-relaxed ${LINE_COLORS[type]}`}>
        {line.trim()}
      </span>
    </div>
  );
}

/* ─── Status helpers ─────────────────────────────────────────────────── */

const STATUS_COLOR: Record<string, string> = {
  success:     'text-emerald-600',
  running:     'text-blue-600',
  failed:      'text-rose-600',
  skipped:     'text-slate-400',
  pending:     'text-slate-400',
  cancelled:   'text-amber-600',
  unreachable: 'text-orange-600',
};

const STAGE_DOT: Record<string, string> = {
  success:     'bg-emerald-500',
  running:     'bg-blue-500 animate-pulse',
  failed:      'bg-rose-500',
  skipped:     'bg-slate-300',
  pending:     'bg-slate-300',
  cancelled:   'bg-amber-400',
  unreachable: 'bg-orange-400',
};

/* ─── Centered Log Modal ─────────────────────────────────────────────── */

interface LogModalProps {
  server: JobServer;
  visibleStages: string[];
  liveDuration: (dur: number, start?: string, running?: boolean) => number;
  onClose: () => void;
}

const LogModal: React.FC<LogModalProps> = ({ server, visibleStages, liveDuration, onClose }) => {
  const stages = (server.stages || []).filter((st) => visibleStages.includes(st.stage_name));
  const [activeStage, setActiveStage] = useState<string>(stages[0]?.stage_name || '');
  const [copied, setCopied] = useState(false);

  // Auto-select first running or failed stage
  useEffect(() => {
    const running = stages.find((s) => s.status === 'running');
    const failed = stages.find((s) => s.status === 'failed');
    if (running) setActiveStage(running.stage_name);
    else if (failed) setActiveStage(failed.stage_name);
    else if (stages.length > 0) setActiveStage(stages[0].stage_name);
  }, [server.id]);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const activeData = stages.find((s) => s.stage_name === activeStage);

  const handleCopy = () => {
    const text = activeData?.stage_logs || '';
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const logLines = (activeData?.stage_logs || '').split('\n').filter(Boolean);

  return (
    <>
      {/* Backdrop — full screen blur */}
      <div
        className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-md transition-opacity"
        onClick={onClose}
      />

      {/* Centered Modal */}
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
        <div
          className="pointer-events-auto w-full max-w-3xl max-h-[85vh] flex flex-col rounded-2xl bg-white border border-slate-200 shadow-2xl shadow-slate-900/20 overflow-hidden"
          style={{ animation: 'modalIn 0.2s cubic-bezier(0.16,1,0.3,1) both' }}
        >
          {/* ── Header ── */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 shrink-0">
            <div className="flex items-center space-x-3">
              <div className="p-2 rounded-xl bg-blue-50 border border-blue-100">
                <ServerIcon className="w-4.5 h-4.5 text-blue-600" />
              </div>
              <div>
                <h3 className="font-bold text-slate-900 text-sm">{server.server_hostname}</h3>
                <p className="text-[11px] text-slate-400 font-mono">{server.server_ip}</p>
              </div>
            </div>
            <div className="flex items-center space-x-3">
              <span className={`text-xs font-bold uppercase font-mono px-2.5 py-1 rounded-lg border ${
                server.status === 'success' ? 'bg-emerald-50 text-emerald-700 border-emerald-200' :
                server.status === 'failed' ? 'bg-rose-50 text-rose-700 border-rose-200' :
                server.status === 'running' ? 'bg-blue-50 text-blue-700 border-blue-200' :
                'bg-slate-50 text-slate-600 border-slate-200'
              }`}>
                {server.status}
              </span>
              <button
                onClick={onClose}
                className="p-2 rounded-xl text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* ── Error banner ── */}
          {server.error_details && (
            <div className="mx-6 mt-4 p-3.5 rounded-xl bg-rose-50 border border-rose-200 shrink-0">
              <div className="flex items-start space-x-2">
                <XCircle className="w-4 h-4 text-rose-500 shrink-0 mt-0.5" />
                <div className="text-xs text-rose-700">
                  <div className="font-bold mb-0.5">Execution Error</div>
                  <div className="font-mono">{server.error_details}</div>
                </div>
              </div>
            </div>
          )}

          {/* ── Unreachable hint ── */}
          {(server.status === 'failed' || (server.status as string) === 'unreachable') && (
            <div className="mx-6 mt-3 p-3 rounded-xl bg-amber-50 border border-amber-200 text-xs text-amber-800 shrink-0">
              <div className="flex items-center space-x-2 font-semibold mb-1">
                <AlertTriangle className="w-3.5 h-3.5 text-amber-600" />
                <span>Target unreachable or connection refused?</span>
              </div>
              <ul className="list-disc ml-6 space-y-0.5 text-amber-700">
                <li><strong>Windows:</strong> WinRM HTTPS (port 5986)</li>
                <li><strong>Linux:</strong> OpenSSH &amp; Python 3</li>
              </ul>
            </div>
          )}

          {/* ── Stage tabs ── */}
          <div className="flex items-center gap-2 px-6 pt-4 pb-3 overflow-x-auto shrink-0">
            {stages.length === 0 ? (
              <span className="text-xs text-slate-400 font-mono">No stage data available yet.</span>
            ) : (
              stages.map((st) => {
                const isActive = activeStage === st.stage_name;
                const dur = liveDuration(st.duration_seconds, st.start_time, st.status === 'running');
                return (
                  <button
                    key={st.stage_name}
                    onClick={() => setActiveStage(st.stage_name)}
                    className={`flex items-center space-x-2 px-4 py-2 rounded-xl text-xs font-semibold whitespace-nowrap transition-all border ${
                      isActive
                        ? 'bg-blue-600 text-white border-blue-600 shadow-md shadow-blue-500/25'
                        : 'bg-white text-slate-600 border-slate-200 hover:border-blue-300 hover:text-blue-600'
                    }`}
                  >
                    <span className={`w-2 h-2 rounded-full shrink-0 ${isActive ? 'bg-white' : STAGE_DOT[st.status] || 'bg-slate-400'}`} />
                    <span>{st.stage_name}</span>
                    <span className={`font-mono text-[10px] ${isActive ? 'text-blue-100' : STATUS_COLOR[st.status] || 'text-slate-400'}`}>
                      {formatDuration(dur)}
                    </span>
                  </button>
                );
              })
            )}
          </div>

          {/* ── Active stage info bar ── */}
          {activeData && (
            <div className="flex items-center justify-between px-6 py-2.5 bg-slate-50 border-y border-slate-100 shrink-0">
              <div className="flex items-center space-x-2 text-xs">
                <Terminal className="w-3.5 h-3.5 text-slate-400" />
                <span className="font-semibold text-slate-700">{activeData.stage_name}</span>
                <span className="text-slate-300">·</span>
                <span className={`font-bold uppercase font-mono text-[11px] ${STATUS_COLOR[activeData.status] || 'text-slate-600'}`}>
                  {activeData.status}
                </span>
                <span className="text-slate-300">·</span>
                <span className="font-mono text-slate-500">
                  {formatDuration(liveDuration(activeData.duration_seconds, activeData.start_time, activeData.status === 'running'))}
                </span>
              </div>
              {activeData.stage_logs && (
                <button
                  onClick={handleCopy}
                  className="flex items-center space-x-1.5 text-xs text-slate-400 hover:text-slate-700 transition-colors"
                >
                  {copied ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
                  <span className="font-mono">{copied ? 'Copied!' : 'Copy'}</span>
                </button>
              )}
            </div>
          )}

          {/* ── Log content ── */}
          <div className="flex-1 overflow-y-auto min-h-0">
            {logLines.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-slate-300">
                <FileText className="w-10 h-10 mb-3" />
                <p className="text-sm font-mono text-slate-400">No logs available for this stage.</p>
              </div>
            ) : (
              <div className="px-6 py-4 space-y-0">
                {logLines.map((line, idx) => (
                  <LogLine key={idx} line={line} idx={idx} />
                ))}
              </div>
            )}
          </div>

          {/* ── Footer ── */}
          <div className="shrink-0 px-6 py-3.5 border-t border-slate-100 bg-slate-50/80 flex items-center justify-between">
            <span className="text-[11px] text-slate-400 font-mono">
              Total: <strong className="text-slate-700">{formatDuration(server.duration_seconds)}</strong>
              {logLines.length > 0 && (
                <> · {logLines.length} line{logLines.length !== 1 ? 's' : ''}</>
              )}
            </span>
            <button
              onClick={onClose}
              className="px-4 py-2 rounded-xl text-xs font-semibold text-slate-600 bg-white border border-slate-200 hover:bg-slate-50 hover:border-slate-300 transition-colors shadow-xs"
            >
              Close
            </button>
          </div>
        </div>
      </div>

      <style>{`
        @keyframes modalIn {
          from { transform: scale(0.95) translateY(10px); opacity: 0; }
          to   { transform: scale(1) translateY(0);       opacity: 1; }
        }
      `}</style>
    </>
  );
};

/* ─── Main StageMatrix Component ────────────────────────────────────── */

export const StageMatrix: React.FC<StageMatrixProps> = ({
  servers,
  jobStatus,
  updateType,
  rebootOnly,
  cleanCacheOnly,
  now,
}) => {
  const [selectedServer, setSelectedServer] = useState<JobServer | null>(null);

  const visibleStages = (() => {
    if (updateType === 'discovery') return ['Discovery'];
    if (rebootOnly === true) return ['Reboot'];
    if (cleanCacheOnly === true) return ['Update'];
    const presentStageNames = Array.from(
      new Set(servers?.flatMap((s) => s.stages?.map((st) => st.stage_name) || []) || [])
    );
    if (presentStageNames.length > 0) {
      return ALL_STAGES.filter((st) => presentStageNames.includes(st));
    }
    return ALL_STAGES;
  })();

  const liveDuration = (duration: number, startTime?: string, isRunning = false) => {
    if (!isRunning || !startTime) return duration;
    const started = parseUtcDate(startTime);
    if (!started) return duration;
    return Math.max(0, Math.floor((now - started.getTime()) / 1000));
  };

  const getStatusBadge = (status: StageStatus, duration: number) => {
    switch (status) {
      case 'success':
        return (
          <div className="flex items-center justify-between px-3 py-1.5 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-700 text-xs font-medium">
            <div className="flex items-center space-x-1.5">
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
              <span>Success</span>
            </div>
            {duration >= 0 && (
              <span className="text-[10px] text-emerald-600 font-mono ml-2">{formatDuration(duration)}</span>
            )}
          </div>
        );
      case 'running':
        return (
          <div className="flex items-center justify-between px-3 py-1.5 rounded-lg bg-blue-50 border border-blue-300 text-blue-700 text-xs font-medium animate-pulse">
            <div className="flex items-center space-x-1.5">
              <RefreshCw className="w-3.5 h-3.5 text-blue-500 animate-spin" />
              <span>Running</span>
            </div>
            {duration >= 0 && (
              <span className="text-[10px] text-blue-600 font-mono ml-2">{formatDuration(duration)}</span>
            )}
          </div>
        );
      case 'failed':
        return (
          <div className="flex items-center justify-between px-3 py-1.5 rounded-lg bg-rose-50 border border-rose-200 text-rose-700 text-xs font-medium">
            <div className="flex items-center space-x-1.5">
              <XCircle className="w-3.5 h-3.5 text-rose-500" />
              <span>Failed</span>
            </div>
            {duration >= 0 && (
              <span className="text-[10px] text-rose-600 font-mono ml-2">{formatDuration(duration)}</span>
            )}
          </div>
        );
      case 'unreachable':
        return (
          <div className="flex items-center px-3 py-1.5 rounded-lg bg-orange-50 border border-orange-200 text-orange-700 text-xs font-medium">
            <AlertTriangle className="w-3.5 h-3.5 text-orange-500 mr-1.5" />
            <span>Unreachable</span>
          </div>
        );
      case 'skipped':
        return (
          <div className="flex items-center px-3 py-1.5 rounded-lg bg-slate-100 border border-slate-200 text-slate-500 text-xs font-medium">
            <Ban className="w-3.5 h-3.5 text-slate-400 mr-1.5" />
            <span>Skipped</span>
          </div>
        );
      case 'cancelled':
        return (
          <div className="flex items-center px-3 py-1.5 rounded-lg bg-amber-50 border border-amber-200 text-amber-700 text-xs font-medium">
            <Ban className="w-3.5 h-3.5 text-amber-500 mr-1.5" />
            <span>Cancelled</span>
          </div>
        );
      default:
        return (
          <div className="flex items-center px-3 py-1.5 rounded-lg bg-slate-50 border border-slate-200 text-slate-400 text-xs font-medium">
            <Clock className="w-3.5 h-3.5 mr-1.5" />
            <span>Pending</span>
          </div>
        );
    }
  };

  const getStageForName = (server: JobServer, stageName: string): PipelineStage | undefined =>
    server.stages?.find((s) => s.stage_name === stageName);

  if (!servers || servers.length === 0) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-10 text-center shadow-xs">
        <ServerIcon className="w-8 h-8 text-slate-200 mx-auto mb-2" />
        <p className="text-sm text-slate-400 font-mono">No endpoint records yet.</p>
      </div>
    );
  }

  return (
    <>
      <div className="rounded-xl border border-slate-200 bg-white shadow-xs overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200">
                <th className="text-left px-5 py-3 font-semibold text-slate-500 uppercase tracking-wider text-[11px] w-52">
                  Target Node
                </th>
                {visibleStages.map((stage) => (
                  <th key={stage} className="text-center px-2 py-3 font-semibold text-slate-500 uppercase tracking-wider text-[11px] min-w-32">
                    {stage}
                  </th>
                ))}
                <th className="text-right px-5 py-3 font-semibold text-slate-500 uppercase tracking-wider text-[11px]">
                  Logs
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {servers.map((server) => {
                const isSelected = selectedServer?.id === server.id;
                const hasFailed = server.status === 'failed' || (server.status as string) === 'unreachable';

                return (
                  <tr
                    key={server.id}
                    className={`transition-colors ${isSelected ? 'bg-blue-50/40' : 'hover:bg-slate-50/60'}`}
                  >
                    <td className="px-5 py-3.5">
                      <div className="flex items-center space-x-2.5">
                        <div className={`w-2 h-2 rounded-full shrink-0 ${
                          hasFailed ? 'bg-rose-500' :
                          server.status === 'running' ? 'bg-blue-500 animate-pulse' :
                          server.status === 'success' ? 'bg-emerald-500' :
                          'bg-slate-300'
                        }`} />
                        <div>
                          <div className="font-semibold text-slate-900 font-['Plus_Jakarta_Sans',sans-serif] text-sm">{server.server_hostname}</div>
                          <div className="text-xs text-slate-500 font-['Plus_Jakarta_Sans',sans-serif]">{server.server_ip}</div>
                        </div>
                      </div>
                    </td>

                    {visibleStages.map((stageName) => {
                      const stage = getStageForName(server, stageName);
                      if (!stage) {
                        return (
                          <td key={stageName} className="px-2 py-3.5">
                            <div className="flex items-center px-3 py-1.5 rounded-lg bg-slate-50 border border-slate-200 text-slate-300 text-xs">
                              <Clock className="w-3 h-3 mr-1" />
                              <span>—</span>
                            </div>
                          </td>
                        );
                      }
                      const dur = liveDuration(stage.duration_seconds, stage.start_time, stage.status === 'running');
                      return (
                        <td key={stageName} className="px-2 py-3.5">
                          {getStatusBadge(stage.status as StageStatus, dur)}
                        </td>
                      );
                    })}

                    <td className="px-5 py-3.5 text-right">
                      <button
                        onClick={() => setSelectedServer(isSelected ? null : server)}
                        className={`inline-flex items-center space-x-1.5 text-xs font-semibold px-3.5 py-2 rounded-xl border transition-all ${
                          isSelected
                            ? 'bg-blue-600 text-white border-blue-600 shadow-sm'
                            : hasFailed
                            ? 'bg-rose-50 text-rose-600 border-rose-200 hover:bg-rose-100'
                            : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50 hover:border-slate-300'
                        }`}
                      >
                        <Terminal className="w-3.5 h-3.5" />
                        <span>View Logs</span>
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Centered Log Modal with Backdrop Blur */}
      {selectedServer && (
        <LogModal
          server={selectedServer}
          visibleStages={visibleStages}
          liveDuration={liveDuration}
          onClose={() => setSelectedServer(null)}
        />
      )}
    </>
  );
};
