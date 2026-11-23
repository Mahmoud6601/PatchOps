import React, { useEffect, useState } from 'react';
import { Calendar, Clock, Pencil, Plus, Power, Trash2, Sparkles, SlidersHorizontal, X } from 'lucide-react';
import { Schedule, Server, ServerGroup, User } from '../types';
import { api } from '../api';
import { useToast } from '../components/Toast';
import { ConfirmModal } from '../components/ConfirmModal';
import { formatUtcDate, parseUtcDate } from '../date';

interface SchedulesPageProps {
  currentUser: User | null;
}

type RecurrencePreset = 'daily' | 'weekly' | 'monthly' | 'hourly' | 'custom';

const DAYS_OF_WEEK = [
  { val: 0, short: 'Sun', full: 'Sunday' },
  { val: 1, short: 'Mon', full: 'Monday' },
  { val: 2, short: 'Tue', full: 'Tuesday' },
  { val: 3, short: 'Wed', full: 'Wednesday' },
  { val: 4, short: 'Thu', full: 'Thursday' },
  { val: 5, short: 'Fri', full: 'Friday' },
  { val: 6, short: 'Sat', full: 'Saturday' },
];

const COMMON_TIMEZONES = [
  'UTC',
  'Africa/Cairo',
  'Asia/Riyadh',
  'Asia/Dubai',
  'Europe/London',
  'Europe/Berlin',
  'America/New_York',
  'America/Chicago',
];

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function buildCronFromVisual(
  preset: RecurrencePreset,
  timeStr: string,
  weekDays: number[],
  monthDay: number,
  everyHours: number,
  rawCustom: string
): string {
  if (preset === 'custom') return rawCustom.trim();
  const [hRaw, mRaw] = (timeStr || '02:00').split(':');
  const hour = Math.min(23, Math.max(0, Number(hRaw) || 0));
  const minute = Math.min(59, Math.max(0, Number(mRaw) || 0));

  if (preset === 'hourly') {
    const step = Math.max(1, Math.min(12, everyHours || 4));
    return step === 1 ? `${minute} * * * *` : `${minute} */${step} * * *`;
  }
  if (preset === 'daily') {
    return `${minute} ${hour} * * *`;
  }
  if (preset === 'weekly') {
    const sortedDays = (weekDays.length ? [...weekDays] : [0]).sort((a, b) => a - b);
    return `${minute} ${hour} * * ${sortedDays.join(',')}`;
  }
  if (preset === 'monthly') {
    const dom = Math.min(28, Math.max(1, monthDay || 1));
    return `${minute} ${hour} ${dom} * *`;
  }
  return rawCustom.trim();
}

function parseCronIntoVisual(expr: string): {
  preset: RecurrencePreset;
  timeStr: string;
  weekDays: number[];
  monthDay: number;
  everyHours: number;
} {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    return { preset: 'custom', timeStr: '02:00', weekDays: [0], monthDay: 1, everyHours: 6 };
  }
  const [minP, hourP, domP, monP, dowP] = parts;
  const isInt = (s: string) => /^\d+$/.test(s);

  if (isInt(minP) && (hourP === '*' || /^\*\/\d+$/.test(hourP)) && domP === '*' && monP === '*' && dowP === '*') {
    const step = hourP === '*' ? 1 : Number(hourP.slice(2)) || 4;
    return {
      preset: 'hourly',
      timeStr: `00:${pad2(Number(minP))}`,
      weekDays: [0],
      monthDay: 1,
      everyHours: step,
    };
  }

  if (isInt(minP) && isInt(hourP) && monP === '*') {
    const timeStr = `${pad2(Number(hourP))}:${pad2(Number(minP))}`;
    if (domP === '*' && dowP === '*') {
      return { preset: 'daily', timeStr, weekDays: [0], monthDay: 1, everyHours: 6 };
    }
    if (domP === '*' && /^[0-6](,[0-6])*$/.test(dowP)) {
      const days = dowP.split(',').map((d) => Number(d));
      return { preset: 'weekly', timeStr, weekDays: days, monthDay: 1, everyHours: 6 };
    }
    if (isInt(domP) && Number(domP) >= 1 && Number(domP) <= 28 && dowP === '*') {
      return { preset: 'monthly', timeStr, weekDays: [0], monthDay: Number(domP), everyHours: 6 };
    }
  }

  return { preset: 'custom', timeStr: '02:00', weekDays: [0], monthDay: 1, everyHours: 6 };
}

export function describeCronExpression(expr?: string | null): string {
  if (!expr) return '';
  const parsed = parseCronIntoVisual(expr);
  if (parsed.preset === 'daily') {
    return `Daily at ${parsed.timeStr}`;
  }
  if (parsed.preset === 'weekly') {
    const names = parsed.weekDays
      .map((d) => DAYS_OF_WEEK.find((item) => item.val === d)?.short || String(d))
      .join(', ');
    return `Every ${names} at ${parsed.timeStr}`;
  }
  if (parsed.preset === 'monthly') {
    return `Monthly on day ${parsed.monthDay} at ${parsed.timeStr}`;
  }
  if (parsed.preset === 'hourly') {
    const minPart = parsed.timeStr.split(':')[1] || '00';
    return parsed.everyHours === 1
      ? `Every hour at :${minPart}`
      : `Every ${parsed.everyHours} hours (at :${minPart})`;
  }
  return `Cron: ${expr}`;
}

const asUtcDate = (value?: string | null) => parseUtcDate(value);

const localDateTimeInput = (value?: string | null, timeZone = 'UTC') => {
  const date = asUtcDate(value);
  if (!date || Number.isNaN(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date).reduce<Record<string, string>>((result, part) => {
    if (part.type !== 'literal') result[part.type] = part.value;
    return result;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
};

const displayInTimeZone = (value: string | null | undefined, timeZone: string) => {
  return formatUtcDate(value, timeZone);
};

const resolveDefaultTimezone = (): string => {
  if (typeof window !== 'undefined') {
    const saved = localStorage.getItem('patching_default_timezone');
    if (saved) return saved;
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
};

export const SchedulesPage: React.FC<SchedulesPageProps> = ({ currentUser }) => {
  const canOperate = currentUser?.role === 'administrator' || currentUser?.role === 'operator';
  const isAdmin = currentUser?.role === 'administrator';
  const hasOsRestriction = Boolean(!isAdmin && currentUser?.allowed_os_families && currentUser.allowed_os_families.length > 0);
  const { success, error: toastError } = useToast();

  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [servers, setServers] = useState<Server[]>([]);
  const [groups, setGroups] = useState<ServerGroup[]>([]);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editing, setEditing] = useState<Schedule | null>(null);
  const [name, setName] = useState('');
  const [updateType, setUpdateType] = useState<'discovery' | 'security' | 'regular'>('security');
  const [triggerType, setTriggerType] = useState<'one-time' | 'recurring'>('recurring');

  // Visual Recurrence Picker State
  const [recurrencePreset, setRecurrencePreset] = useState<RecurrencePreset>('weekly');
  const [visualTime, setVisualTime] = useState('02:00');
  const [visualWeekDays, setVisualWeekDays] = useState<number[]>([0]);
  const [visualMonthDay, setVisualMonthDay] = useState<number>(1);
  const [visualEveryHours, setVisualEveryHours] = useState<number>(6);
  const [cron, setCron] = useState('0 2 * * 0');

  const [scheduledAt, setScheduledAt] = useState('');
  const [timezone, setTimezone] = useState(resolveDefaultTimezone);
  const [targetMode, setTargetMode] = useState<'servers' | 'group'>('servers');
  const [selectedServers, setSelectedServers] = useState<number[]>([]);
  const [groupId, setGroupId] = useState('');
  const [maintenanceWindow, setMaintenanceWindow] = useState(120);
  const [preventOverlap, setPreventOverlap] = useState(true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

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

  // Sync visual controls -> cron string whenever visual controls change (except in custom mode)
  useEffect(() => {
    if (recurrencePreset !== 'custom') {
      setCron(
        buildCronFromVisual(
          recurrencePreset,
          visualTime,
          visualWeekDays,
          visualMonthDay,
          visualEveryHours,
          cron
        )
      );
    }
  }, [recurrencePreset, visualTime, visualWeekDays, visualMonthDay, visualEveryHours]);

  const load = async () => {
    const [scheduleData, serverData, groupData] = await Promise.all([
      api.getSchedules(),
      api.getServers(),
      api.getServerGroups(),
    ]);
    setSchedules(scheduleData);
    setServers(serverData);
    setGroups(groupData);
  };

  useEffect(() => {
    load().catch((err: Error) => setError(err.message));
  }, []);

  const resetForm = () => {
    setEditing(null);
    setName('');
    setUpdateType('security');
    setTriggerType('recurring');
    setRecurrencePreset('weekly');
    setVisualTime('02:00');
    setVisualWeekDays([0]);
    setVisualMonthDay(1);
    setVisualEveryHours(6);
    setCron('0 2 * * 0');
    setScheduledAt('');
    setTimezone(resolveDefaultTimezone());
    setTargetMode('servers');
    setSelectedServers([]);
    setGroupId('');
    setMaintenanceWindow(120);
    setPreventOverlap(true);
    setError('');
  };

  const openEdit = (schedule: Schedule) => {
    setEditing(schedule);
    setName(schedule.name);
    setUpdateType((schedule.update_type as 'discovery' | 'security' | 'regular') || 'security');
    setTriggerType(schedule.cron_expression ? 'recurring' : 'one-time');
    const expr = schedule.cron_expression || '0 2 * * 0';
    setCron(expr);
    const parsed = parseCronIntoVisual(expr);
    setRecurrencePreset(parsed.preset);
    setVisualTime(parsed.timeStr);
    setVisualWeekDays(parsed.weekDays);
    setVisualMonthDay(parsed.monthDay);
    setVisualEveryHours(parsed.everyHours);

    setTimezone(schedule.timezone || 'UTC');
    setScheduledAt(localDateTimeInput(schedule.scheduled_time, schedule.timezone || 'UTC'));
    setTargetMode(schedule.target_group_id ? 'group' : 'servers');
    setSelectedServers(schedule.target_servers || []);
    setGroupId(schedule.target_group_id ? String(schedule.target_group_id) : '');
    setMaintenanceWindow(schedule.maintenance_window_mins);
    setPreventOverlap(schedule.prevent_overlap);
    setError('');
    setIsModalOpen(true);
  };

  const toggleServer = (id: number) => {
    setSelectedServers((current) =>
      current.includes(id) ? current.filter((x) => x !== id) : [...current, id]
    );
  };

  const toggleWeekDay = (dayVal: number) => {
    setVisualWeekDays((prev) => {
      if (prev.includes(dayVal)) {
        return prev.length > 1 ? prev.filter((d) => d !== dayVal) : prev;
      }
      return [...prev, dayVal].sort((a, b) => a - b);
    });
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError('');
    try {
      const payload: any = {
        name,
        update_type: updateType,
        timezone,
        maintenance_window_mins: Number(maintenanceWindow),
        prevent_overlap: isAdmin ? preventOverlap : true,
        cron_expression: triggerType === 'recurring' ? cron.trim() : null,
        scheduled_time: triggerType === 'one-time' && scheduledAt ? `${scheduledAt}:00` : null,
        target_group_id: targetMode === 'group' && groupId ? Number(groupId) : null,
        target_servers: targetMode === 'servers' ? selectedServers : [],
      };
      if (editing) {
        await api.updateSchedule(editing.id, payload);
        success('Schedule Updated', name);
      } else {
        await api.createSchedule(payload);
        success('Schedule Created', name);
      }
      setIsModalOpen(false);
      resetForm();
      await load();
    } catch (err: any) {
      setError(err.message || 'Could not save schedule');
      toastError('Save Failed', err.message || 'Could not save schedule');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = (schedule: Schedule) => {
    showConfirm(
      'Delete Schedule',
      `Permanently delete schedule "${schedule.name}"? This cannot be undone.`,
      'Delete',
      'danger',
      async () => {
        closeConfirm();
        try {
          await api.deleteSchedule(schedule.id);
          success('Schedule Deleted', schedule.name);
          await load();
        } catch (err: any) {
          toastError('Delete Failed', err.message || 'Could not delete schedule');
        }
      }
    );
  };

  const handleToggle = async (schedule: Schedule) => {
    try {
      await api.toggleSchedule(schedule.id);
      success(schedule.is_active ? 'Schedule Paused' : 'Schedule Activated', schedule.name);
      await load();
    } catch (err: any) {
      toastError('Toggle Failed', err.message || 'Could not toggle schedule');
    }
  };

  const badgeStyleForType = (typeVal: string) => {
    if (typeVal === 'discovery') return 'bg-indigo-50 text-indigo-700 border border-indigo-200';
    if (typeVal === 'security') return 'bg-rose-50 text-rose-700 border border-rose-200';
    return 'bg-blue-50 text-blue-700 border border-blue-200';
  };

  return (
    <div className="space-y-6">
      <ConfirmModal
        isOpen={confirmModal.open}
        title={confirmModal.title}
        message={confirmModal.message}
        confirmLabel={confirmModal.confirmLabel}
        variant={confirmModal.variant}
        onConfirm={confirmModal.onConfirm}
        onCancel={closeConfirm}
      />

      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-900 tracking-tight">Automation Policies &amp; Schedules</h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Schedule recurring endpoint discovery scans, security rollouts, and maintenance windows.
          </p>
        </div>
        {canOperate && (
          <button
            onClick={() => {
              resetForm();
              setIsModalOpen(true);
            }}
            className="inline-flex items-center space-x-2 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold shadow-sm transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>New Automation Policy</span>
          </button>
        )}
      </div>

      {error && !isModalOpen && (
        <div className="p-3 rounded-lg bg-rose-50 border border-rose-200 text-rose-700 text-xs">{error}</div>
      )}

      {/* Schedule Cards */}
      {schedules.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-200 bg-white p-12 text-center">
          <Calendar className="w-10 h-10 text-slate-300 mx-auto mb-3" />
          <p className="text-sm font-medium text-slate-500">No automation policies configured</p>
          <p className="text-xs text-slate-400 mt-1">
            Create a recurring Discovery scan or automated Patching window above.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {schedules.map((schedule) => (
            <div
              key={schedule.id}
              className={`rounded-xl border bg-white shadow-sm p-5 transition-all ${
                schedule.is_active ? 'border-slate-200' : 'border-slate-100 opacity-60'
              }`}
            >
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold text-slate-900 text-sm truncate">{schedule.name}</span>
                    <span
                      className={`text-[10px] px-2 py-0.5 rounded-full font-semibold font-mono uppercase ${badgeStyleForType(
                        schedule.update_type
                      )}`}
                    >
                      {schedule.update_type}
                    </span>
                    <span
                      className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${
                        schedule.is_active
                          ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                          : 'bg-slate-100 text-slate-500 border border-slate-200'
                      }`}
                    >
                      {schedule.is_active ? 'Active' : 'Paused'}
                    </span>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500">
                    {schedule.cron_expression && (
                      <span className="flex items-center gap-1.5">
                        <Clock className="w-3.5 h-3.5 text-indigo-500" />
                        <span className="font-semibold text-slate-700">
                          {describeCronExpression(schedule.cron_expression)}
                        </span>
                        <span className="font-mono text-[11px] px-1.5 py-0.2 rounded bg-slate-100 text-slate-500">
                          {schedule.cron_expression}
                        </span>
                        {schedule.timezone && <span className="text-slate-400">({schedule.timezone})</span>}
                      </span>
                    )}
                    {schedule.scheduled_time && (
                      <span className="flex items-center gap-1">
                        <Calendar className="w-3.5 h-3.5 text-blue-500" />
                        <span>{displayInTimeZone(schedule.scheduled_time, schedule.timezone || 'UTC')}</span>
                      </span>
                    )}
                    {schedule.next_run_at && (
                      <span className="text-blue-600 font-medium">
                        Next: {displayInTimeZone(schedule.next_run_at, schedule.timezone || 'UTC')}
                      </span>
                    )}
                    <span>{schedule.maintenance_window_mins}min window</span>
                    {schedule.prevent_overlap && <span className="text-amber-600 font-medium">No-overlap</span>}
                  </div>
                </div>
                {canOperate && (
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={() => handleToggle(schedule)}
                      title={schedule.is_active ? 'Pause schedule' : 'Activate schedule'}
                      className={`p-2 rounded-lg border text-xs font-medium transition-colors ${
                        schedule.is_active
                          ? 'bg-amber-50 hover:bg-amber-100 border-amber-200 text-amber-700'
                          : 'bg-emerald-50 hover:bg-emerald-100 border-emerald-200 text-emerald-700'
                      }`}
                    >
                      <Power className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => openEdit(schedule)}
                      className="p-2 rounded-lg bg-slate-50 hover:bg-slate-100 border border-slate-200 text-slate-600 transition-colors"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => handleDelete(schedule)}
                      className="p-2 rounded-lg bg-rose-50 hover:bg-rose-100 border border-rose-200 text-rose-600 transition-colors"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Create / Edit Modal */}
      {isModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-md"
          onClick={() => setIsModalOpen(false)}
        >
          <div
            className="relative z-10 w-full max-w-xl bg-white rounded-2xl shadow-2xl border border-slate-200 overflow-hidden"
            style={{ animation: 'scaleIn 0.18s ease-out' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 bg-slate-50/70">
              <div className="flex items-center space-x-2">
                <Sparkles className="w-4 h-4 text-blue-600" />
                <h3 className="text-sm font-bold text-slate-900">
                  {editing ? 'Edit Automation Policy' : 'New Automation Policy'}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setIsModalOpen(false)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={save} className="p-6 space-y-4 max-h-[78vh] overflow-y-auto">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Policy Name *</label>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  placeholder="e.g. Nightly Fleet Discovery or Sunday Security Rollout"
                  className="w-full rounded-lg bg-white border border-slate-300 px-3 py-2 text-slate-900 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-600"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Workflow Type</label>
                  <select
                    value={updateType}
                    onChange={(e) => setUpdateType(e.target.value as any)}
                    className="w-full rounded-lg bg-white border border-slate-300 px-3 py-2 text-slate-900 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-600"
                  >
                    <option value="discovery">Discovery Scan (Telemetry &amp; Updates Check)</option>
                    <option value="security">Security Updates Rollout</option>
                    <option value="regular">Regular Full Patching</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Execution Cadence</label>
                  <select
                    value={triggerType}
                    onChange={(e) => setTriggerType(e.target.value as any)}
                    className="w-full rounded-lg bg-white border border-slate-300 px-3 py-2 text-slate-900 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-600"
                  >
                    <option value="recurring">Recurring Schedule</option>
                    <option value="one-time">One-Time Maintenance Window</option>
                  </select>
                </div>
              </div>

              {triggerType === 'recurring' ? (
                <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-3.5">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-slate-800 flex items-center space-x-1.5">
                      <SlidersHorizontal className="w-3.5 h-3.5 text-blue-600" />
                      <span>Visual Schedule Builder</span>
                    </span>
                    <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-200">
                      {cron}
                    </span>
                  </div>

                  {/* Frequency Tabs */}
                  <div className="grid grid-cols-5 gap-1.5">
                    {(
                      [
                        { id: 'daily', label: 'Daily' },
                        { id: 'weekly', label: 'Weekly' },
                        { id: 'monthly', label: 'Monthly' },
                        { id: 'hourly', label: 'Hourly' },
                        { id: 'custom', label: 'Custom Cron' },
                      ] as { id: RecurrencePreset; label: string }[]
                    ).map((tab) => (
                      <button
                        key={tab.id}
                        type="button"
                        onClick={() => setRecurrencePreset(tab.id)}
                        className={`py-1.5 px-2 rounded-lg text-[11px] font-semibold border transition-all ${
                          recurrencePreset === tab.id
                            ? 'bg-blue-600 text-white border-blue-600 shadow-xs'
                            : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-100'
                        }`}
                      >
                        {tab.label}
                      </button>
                    ))}
                  </div>

                  {recurrencePreset === 'weekly' && (
                    <div className="space-y-3">
                      <div>
                        <label className="block text-[11px] font-semibold text-slate-600 mb-1.5">
                          Days of Week
                        </label>
                        <div className="grid grid-cols-7 gap-1.5">
                          {DAYS_OF_WEEK.map((d) => {
                            const active = visualWeekDays.includes(d.val);
                            return (
                              <button
                                key={d.val}
                                type="button"
                                onClick={() => toggleWeekDay(d.val)}
                                className={`py-1.5 rounded-lg text-xs font-semibold border transition-all ${
                                  active
                                    ? 'bg-indigo-600 text-white border-indigo-600 shadow-xs'
                                    : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-100'
                                }`}
                              >
                                {d.short}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                      <div>
                        <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                          Execution Time (24h)
                        </label>
                        <input
                          type="time"
                          value={visualTime}
                          onChange={(e) => setVisualTime(e.target.value)}
                          className="w-40 rounded-lg bg-white border border-slate-300 px-3 py-1.5 text-xs font-mono text-slate-900 focus:outline-none focus:border-blue-600"
                        />
                      </div>
                    </div>
                  )}

                  {recurrencePreset === 'daily' && (
                    <div>
                      <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                        Daily Execution Time (24h)
                      </label>
                      <input
                        type="time"
                        value={visualTime}
                        onChange={(e) => setVisualTime(e.target.value)}
                        className="w-40 rounded-lg bg-white border border-slate-300 px-3 py-1.5 text-xs font-mono text-slate-900 focus:outline-none focus:border-blue-600"
                      />
                    </div>
                  )}

                  {recurrencePreset === 'monthly' && (
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                          Day of Month (1–28)
                        </label>
                        <input
                          type="number"
                          min={1}
                          max={28}
                          value={visualMonthDay}
                          onChange={(e) => setVisualMonthDay(Number(e.target.value))}
                          className="w-full rounded-lg bg-white border border-slate-300 px-3 py-1.5 text-xs font-mono text-slate-900"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                          Execution Time (24h)
                        </label>
                        <input
                          type="time"
                          value={visualTime}
                          onChange={(e) => setVisualTime(e.target.value)}
                          className="w-full rounded-lg bg-white border border-slate-300 px-3 py-1.5 text-xs font-mono text-slate-900"
                        />
                      </div>
                    </div>
                  )}

                  {recurrencePreset === 'hourly' && (
                    <div>
                      <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                        Repeat Interval
                      </label>
                      <select
                        value={visualEveryHours}
                        onChange={(e) => setVisualEveryHours(Number(e.target.value))}
                        className="w-full rounded-lg bg-white border border-slate-300 px-3 py-1.5 text-xs text-slate-900"
                      >
                        {[1, 2, 4, 6, 8, 12].map((h) => (
                          <option key={h} value={h}>
                            Every {h} {h === 1 ? 'hour' : 'hours'}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}

                  {recurrencePreset === 'custom' && (
                    <div>
                      <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                        5-Field Cron Expression (minute hour dom month dow)
                      </label>
                      <input
                        value={cron}
                        onChange={(e) => setCron(e.target.value)}
                        placeholder="0 2 * * 0"
                        className="w-full font-mono rounded-lg bg-white border border-slate-300 px-3 py-2 text-slate-900 text-xs focus:outline-none focus:border-blue-600"
                      />
                    </div>
                  )}

                  <div className="pt-2 border-t border-slate-200/80 flex items-center justify-between text-[11px]">
                    <span className="text-slate-500">Summary:</span>
                    <span className="font-semibold text-indigo-700">
                      {describeCronExpression(cron)} ({timezone || 'UTC'})
                    </span>
                  </div>
                </div>
              ) : (
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Execution Date &amp; Time *</label>
                  <input
                    type="datetime-local"
                    value={scheduledAt}
                    onChange={(e) => setScheduledAt(e.target.value)}
                    required
                    className="w-full rounded-lg bg-white border border-slate-300 px-3 py-2 text-slate-900 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-600"
                  />
                </div>
              )}

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-xs font-semibold text-slate-700">Timezone (IANA)</label>
                  <div className="flex flex-wrap gap-1">
                    {COMMON_TIMEZONES.slice(0, 4).map((tz) => (
                      <button
                        key={tz}
                        type="button"
                        onClick={() => setTimezone(tz)}
                        className={`px-1.5 py-0.5 rounded text-[10px] font-mono border ${
                          timezone === tz
                            ? 'bg-blue-50 text-blue-700 border-blue-200 font-semibold'
                            : 'bg-slate-50 text-slate-500 border-slate-200 hover:bg-slate-100'
                        }`}
                      >
                        {tz}
                      </button>
                    ))}
                  </div>
                </div>
                <input
                  value={timezone}
                  onChange={(e) => setTimezone(e.target.value)}
                  required
                  className="w-full font-mono rounded-lg bg-white border border-slate-300 px-3 py-2 text-slate-900 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-600"
                />
              </div>

              <div className="flex gap-4">
                <label className="flex items-center gap-2 text-xs text-slate-700 font-medium cursor-pointer">
                  <input
                    type="radio"
                    checked={targetMode === 'servers'}
                    onChange={() => setTargetMode('servers')}
                    className="text-blue-600 focus:ring-blue-500"
                  />
                  <span>Specific Endpoints</span>
                </label>
                {!hasOsRestriction && (
                  <label className="flex items-center gap-2 text-xs text-slate-700 font-medium cursor-pointer">
                    <input
                      type="radio"
                      checked={targetMode === 'group'}
                      onChange={() => setTargetMode('group')}
                      className="text-blue-600 focus:ring-blue-500"
                    />
                    <span>Customer Organization Group</span>
                  </label>
                )}
              </div>

              {targetMode === 'servers' ? (
                <div className="max-h-36 overflow-y-auto rounded-lg border border-slate-200 p-2.5 space-y-1 bg-slate-50">
                  {servers.length === 0 ? (
                    <p className="text-xs text-slate-400 py-2 text-center">No managed endpoints in your scope.</p>
                  ) : (
                    servers.map((s) => (
                      <label key={s.id} className="flex items-center justify-between text-xs text-slate-700 hover:text-slate-900 cursor-pointer px-1 py-0.5 rounded hover:bg-white">
                        <span className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={selectedServers.includes(s.id)}
                            onChange={() => toggleServer(s.id)}
                            className="rounded text-blue-600 focus:ring-blue-500"
                          />
                          <span className="font-medium">{s.hostname}</span>
                          <span className="text-slate-400 font-mono">({s.ip_address})</span>
                        </span>
                        <span className="text-[10px] font-mono uppercase text-slate-400">{s.os_family}</span>
                      </label>
                    ))
                  )}
                </div>
              ) : (
                <select
                  value={groupId}
                  onChange={(e) => setGroupId(e.target.value)}
                  className="w-full rounded-lg bg-white border border-slate-300 px-3 py-2 text-slate-900 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-600"
                >
                  <option value="">Select Customer Organization…</option>
                  {groups.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name} ({g.server_count} hosts)
                    </option>
                  ))}
                </select>
              )}

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Maintenance Window (minutes)
                </label>
                <input
                  type="number"
                  value={maintenanceWindow}
                  onChange={(e) => setMaintenanceWindow(Number(e.target.value))}
                  min={15}
                  max={1440}
                  className="w-full rounded-lg bg-white border border-slate-300 px-3 py-2 text-slate-900 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-600"
                />
              </div>

              {isAdmin && (
                <label className="flex items-center gap-2 text-xs text-slate-700 font-medium cursor-pointer">
                  <input
                    type="checkbox"
                    checked={preventOverlap}
                    onChange={(e) => setPreventOverlap(e.target.checked)}
                    className="rounded text-blue-600 focus:ring-blue-500"
                  />
                  <span>Prevent overlapping pipeline executions (Recommended)</span>
                </label>
              )}

              {error && (
                <div className="p-3 rounded-lg bg-rose-50 border border-rose-200 text-rose-700 text-xs">{error}</div>
              )}

              <div className="flex justify-end gap-2 pt-2 border-t border-slate-200">
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  className="px-4 py-2 rounded-lg bg-white hover:bg-slate-50 border border-slate-300 text-slate-700 text-xs font-semibold transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold shadow-sm transition-colors disabled:opacity-50"
                >
                  {saving ? 'Saving…' : 'Save Policy'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
