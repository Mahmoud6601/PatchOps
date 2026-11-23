import { AuditLog, AwxMachineCredential, DashboardSummary, InstalledPatch, JobEvent, Schedule, Server, ServerGroup, UpdateJob, User } from './types';

const API_BASE = '/api';
const LEGACY_TOKEN_STORAGE_KEY = 'patching_access_token';

// Purge any legacy localStorage JWT from older releases; access tokens stay strictly in JS memory.
if (typeof window !== 'undefined') {
  localStorage.removeItem(LEGACY_TOKEN_STORAGE_KEY);
}

let accessToken: string | null = null;
let refreshPromise: Promise<string | null> | null = null;

export function setAccessToken(token: string | null) {
  accessToken = token;
}

export function getAccessToken(): string | null {
  return accessToken;
}

function headers(init?: HeadersInit, hasBody = false): Headers {
  const value = new Headers(init);
  if (hasBody && !value.has('Content-Type')) value.set('Content-Type', 'application/json');
  if (accessToken) value.set('Authorization', `Bearer ${accessToken}`);
  return value;
}

async function performTokenRefresh(): Promise<string | null> {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    try {
      const response = await fetch(`${API_BASE}/auth/refresh`, {
        method: 'POST',
        credentials: 'same-origin',
      });
      if (!response.ok) {
        setAccessToken(null);
        return null;
      }
      const payload = await response.json();
      if (payload && typeof payload.access_token === 'string') {
        setAccessToken(payload.access_token);
        return payload.access_token;
      }
      setAccessToken(null);
      return null;
    } catch {
      return null;
    } finally {
      refreshPromise = null;
    }
  })();
  return refreshPromise;
}

async function request<T>(path: string, init: RequestInit = {}, allowRefreshRetry = true): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    credentials: 'same-origin',
    headers: headers(init.headers, init.body !== undefined),
  });
  const isAuthLifecycleEndpoint =
    path === '/auth/login' || path === '/auth/refresh' || path === '/auth/logout';

  if (response.status === 401 && !isAuthLifecycleEndpoint) {
    if (allowRefreshRetry) {
      const refreshed = await performTokenRefresh();
      if (refreshed) {
        return request<T>(path, init, false);
      }
    }
    setAccessToken(null);
    if (typeof window !== 'undefined') {
      localStorage.removeItem('patching_cached_user');
      window.dispatchEvent(new Event('patching-auth-expired'));
    }
  }
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const payload = await response.json();
      if (typeof payload.detail === 'string') {
        message = payload.detail;
      } else if (Array.isArray(payload.detail)) {
        message = payload.detail.map((issue: { loc?: unknown[]; msg?: string }) => {
          const field = Array.isArray(issue.loc) ? issue.loc.slice(-1)[0] : undefined;
          return field ? `${String(field)}: ${issue.msg || 'Invalid value'}` : (issue.msg || 'Invalid request');
        }).join('; ') || message;
      }
    } catch {
      // Keep the status-based message for empty or non-JSON error responses.
    }
    throw new Error(message);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const api = {
  setAccessToken,
  getAccessToken,

  login(username: string, password: string): Promise<{ access_token: string; role: string; username: string }> {
    return request('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }, false);
  },

  refreshSession(): Promise<string | null> {
    return performTokenRefresh();
  },

  async logout(): Promise<void> {
    try {
      await request('/auth/logout', { method: 'POST' }, false);
    } finally {
      setAccessToken(null);
    }
  },

  getMe(): Promise<User> {
    return request('/auth/me');
  },

  updateMyProfile(payload: { full_name?: string | null; email?: string | null }): Promise<User> {
    return request('/auth/me', {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
  },

  async changeMyPassword(currentPassword: string, newPassword: string): Promise<void> {
    const res = await request<{ access_token: string }>('/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({
        current_password: currentPassword,
        new_password: newPassword,
      }),
    }, false);
    if (res?.access_token) {
      setAccessToken(res.access_token);
    }
  },

  getDashboardSummary(): Promise<DashboardSummary> {
    return request('/reports/summary');
  },

  getServers(search?: string, osFamily?: string, groupId?: number, includeRetired = false): Promise<Server[]> {
    const params = new URLSearchParams();
    if (search) params.set('search', search);
    if (osFamily) params.set('os_family', osFamily);
    if (groupId) params.set('group_id', String(groupId));
    if (includeRetired) params.set('include_retired', 'true');
    const query = params.toString();
    return request(`/servers${query ? `?${query}` : ''}`);
  },

  createServer(server: Partial<Server>): Promise<Server> {
    return request('/servers', { method: 'POST', body: JSON.stringify(server) });
  },

  updateServer(id: number, server: Partial<Server>): Promise<Server> {
    return request(`/servers/${id}`, { method: 'PUT', body: JSON.stringify(server) });
  },

  deleteServer(id: number): Promise<void> {
    return request(`/servers/${id}`, { method: 'DELETE' });
  },

  restoreServer(id: number): Promise<Server> {
    return request(`/servers/${id}/restore`, { method: 'POST' });
  },

  syncAwxInventory(): Promise<{ inventory_id: number; synchronized_hosts: number }> {
    return request('/servers/sync-awx', { method: 'POST' });
  },

  getAwxMachineCredentials(): Promise<AwxMachineCredential[]> {
    return request('/servers/awx-machine-credentials');
  },

  getServerGroups(): Promise<ServerGroup[]> {
    return request('/servers/groups/list');
  },

  createServerGroup(group: {
    name: string;
    description?: string;
    default_linux_credential_id?: number | null;
    default_windows_credential_id?: number | null;
  }): Promise<ServerGroup> {
    return request('/servers/groups', { method: 'POST', body: JSON.stringify(group) });
  },

  updateServerGroup(
    id: number,
    group: {
      name?: string;
      description?: string;
      default_linux_credential_id?: number | null;
      default_windows_credential_id?: number | null;
    }
  ): Promise<ServerGroup> {
    return request(`/servers/groups/${id}`, { method: 'PUT', body: JSON.stringify(group) });
  },

  deleteServerGroup(id: number): Promise<void> {
    return request(`/servers/groups/${id}`, { method: 'DELETE' });
  },

  bulkAssignGroup(serverIds: number[], groupId: number | null, applyDefaultCredentials: boolean = false): Promise<Server[]> {
    return request('/servers/bulk-assign-group', {
      method: 'POST',
      body: JSON.stringify({
        server_ids: serverIds,
        group_id: groupId,
        apply_default_credentials: applyDefaultCredentials,
      }),
    });
  },

  getJobs(filters?: { status?: string; update_type?: string; search?: string; offset?: number; limit?: number }): Promise<UpdateJob[]> {
    const params = new URLSearchParams();
    Object.entries(filters || {}).forEach(([key, value]) => {
      if (value !== undefined) params.set(key, String(value));
    });
    const query = params.toString();
    return request(`/jobs${query ? `?${query}` : ''}`);
  },

  getJob(buildId: string): Promise<UpdateJob> {
    return request(`/jobs/${encodeURIComponent(buildId)}`);
  },

  getJobEvents(buildId: string): Promise<JobEvent[]> {
    return request(`/jobs/${encodeURIComponent(buildId)}/events`);
  },

  launchJob(payload: {
    job_name: string;
    update_type: string;
    server_ids: number[];
    confirm_major_upgrade?: boolean;
    backup_verified?: boolean;
    allow_overlap?: boolean;
  }): Promise<UpdateJob> {
    return request('/jobs', { method: 'POST', body: JSON.stringify(payload) });
  },

  cancelJob(buildId: string): Promise<{ message: string; status: string }> {
    return request(`/jobs/${encodeURIComponent(buildId)}/cancel`, { method: 'POST' });
  },

  getSchedules(): Promise<Schedule[]> {
    return request('/schedules');
  },

  createSchedule(schedule: Partial<Schedule>): Promise<Schedule> {
    return request('/schedules', { method: 'POST', body: JSON.stringify(schedule) });
  },

  updateSchedule(id: number, schedule: Partial<Schedule>): Promise<Schedule> {
    return request(`/schedules/${id}`, { method: 'PUT', body: JSON.stringify(schedule) });
  },

  toggleSchedule(id: number): Promise<Schedule> {
    return request(`/schedules/${id}/toggle`, { method: 'POST' });
  },

  deleteSchedule(id: number): Promise<void> {
    return request(`/schedules/${id}`, { method: 'DELETE' });
  },

  getAuditLogs(filters?: { search?: string; action?: string; offset?: number; limit?: number }): Promise<AuditLog[]> {
    const params = new URLSearchParams();
    Object.entries(filters || {}).forEach(([key, value]) => {
      if (value !== undefined) params.set(key, String(value));
    });
    const query = params.toString();
    return request(`/audit${query ? `?${query}` : ''}`);
  },

  getUsers(): Promise<User[]> {
    return request('/users');
  },

  createUser(user: {
    username: string;
    full_name?: string;
    email?: string;
    password: string;
    role: string;
    allowed_group_ids?: number[] | null;
    allowed_os_families?: ('linux' | 'windows')[] | null;
  }): Promise<User> {
    return request('/users', { method: 'POST', body: JSON.stringify(user) });
  },

  updateUser(
    id: number,
    update: {
      full_name?: string | null;
      email?: string | null;
      role?: string;
      is_active?: boolean;
      allowed_group_ids?: number[] | null;
      allowed_os_families?: ('linux' | 'windows')[] | null;
    }
  ): Promise<User> {
    return request(`/users/${id}`, { method: 'PUT', body: JSON.stringify(update) });
  },

  resetUserPassword(id: number, newPassword: string): Promise<void> {
    return request(`/users/${id}/reset-password`, { method: 'POST', body: JSON.stringify({ new_password: newPassword }) });
  },

  deleteUser(id: number): Promise<void> {
    return request(`/users/${id}`, { method: 'DELETE' });
  },

  getServerPatches(serverId: number, search?: string, limit = 100): Promise<InstalledPatch[]> {
    const params = new URLSearchParams({ limit: String(limit) });
    if (search && search.trim()) params.set('search', search.trim());
    return request(`/servers/${serverId}/patches?${params.toString()}`);
  },

  getJobPatches(buildId: string): Promise<InstalledPatch[]> {
    return request(`/jobs/${encodeURIComponent(buildId)}/patches`);
  },

  rebootServer(id: number, clearFlagOnly = false, allowOverlap = false): Promise<UpdateJob> {
    const params = new URLSearchParams();
    if (clearFlagOnly) params.set('action', 'clear_flag');
    if (allowOverlap) params.set('allow_overlap', 'true');
    const qs = params.toString();
    return request(`/servers/${id}/reboot${qs ? `?${qs}` : ''}`, { method: 'POST' });
  },

  bulkReboot(serverIds: number[], clearFlagOnly = false, allowOverlap = false): Promise<UpdateJob> {
    return request('/servers/bulk-reboot', {
      method: 'POST',
      body: JSON.stringify({
        server_ids: serverIds,
        action: clearFlagOnly ? 'clear_flag' : 'reboot',
        allow_overlap: allowOverlap,
      }),
    });
  },

  resetWindowsCache(id: number, allowOverlap = false): Promise<UpdateJob> {
    return request(`/servers/${id}/reset-windows-cache${allowOverlap ? '?allow_overlap=true' : ''}`, { method: 'POST' });
  },

  bulkResetWindowsCache(serverIds: number[], allowOverlap = false): Promise<UpdateJob> {
    return request('/servers/bulk-reset-windows-cache', {
      method: 'POST',
      body: JSON.stringify({ server_ids: serverIds, allow_overlap: allowOverlap }),
    });
  },

  retryFailedHosts(buildId: string, allBatch = false, allowOverlap = false): Promise<UpdateJob> {
    const params = new URLSearchParams();
    if (allBatch) params.set('all_batch', 'true');
    if (allowOverlap) params.set('allow_overlap', 'true');
    const qs = params.toString();
    return request(`/jobs/${encodeURIComponent(buildId)}/retry-failed${qs ? `?${qs}` : ''}`, {
      method: 'POST',
    });
  },

  async checkAwxHealth(): Promise<{ status: string; reason?: string }> {
    return request<{ status: string; reason?: string }>("/health/awx");
  },

  async downloadJobCsv(buildId: string): Promise<void> {
    const cleanSlug = buildId.replace(/^(RUN-|BUILD-#?)/, '').replace('#', '') || buildId.replace('#', '');
    await download(`/jobs/${encodeURIComponent(buildId)}/export`, `run-${cleanSlug}.csv`);
  },

  async downloadPatchHistory(start?: string, end?: string): Promise<void> {
    const params = new URLSearchParams();
    if (start) params.set('start', start);
    if (end) params.set('end', end);
    const query = params.toString();
    await download(`/reports/patch-history.csv${query ? `?${query}` : ''}`, 'patch-history.csv');
  },

  subscribeSse(
    path: string,
    onEvent: (eventName: string, data: any) => void,
    onStateChange?: (connected: boolean) => void
  ): () => void {
    const abortController = new AbortController();
    let stopped = false;

    const connect = async () => {
      let retryDelayMs = 2000;
      while (!stopped && !abortController.signal.aborted) {
        if (typeof window !== 'undefined' && localStorage.getItem('patching_live_stream') === 'false') {
          onStateChange?.(false);
          await new Promise((r) => setTimeout(r, 5000));
          continue;
        }
        try {
          let response = await fetch(`${API_BASE}${path}`, {
            method: 'GET',
            credentials: 'same-origin',
            headers: headers({ Accept: 'text/event-stream' }),
            signal: abortController.signal,
          });
          if (response.status === 401) {
            const refreshed = await performTokenRefresh();
            if (!refreshed) {
              onStateChange?.(false);
              return;
            }
            response = await fetch(`${API_BASE}${path}`, {
              method: 'GET',
              credentials: 'same-origin',
              headers: headers({ Accept: 'text/event-stream' }),
              signal: abortController.signal,
            });
          }
          if (!response.ok || !response.body) {
            onStateChange?.(false);
            if (response.status === 403 || response.status === 404) {
              return;
            }
            await new Promise((r) => setTimeout(r, retryDelayMs));
            retryDelayMs = Math.min(retryDelayMs * 2, 15000);
            continue;
          }

          onStateChange?.(true);
          retryDelayMs = 2000;
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';

          while (!stopped && !abortController.signal.aborted) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let boundary = buffer.indexOf('\n\n');
            while (boundary !== -1) {
              const rawFrame = buffer.slice(0, boundary);
              buffer = buffer.slice(boundary + 2);
              boundary = buffer.indexOf('\n\n');

              if (!rawFrame.trim() || rawFrame.startsWith(':')) {
                continue;
              }
              let eventName = 'message';
              const dataLines: string[] = [];
              for (const line of rawFrame.split('\n')) {
                if (line.startsWith('event:')) {
                  eventName = line.slice(6).trim();
                } else if (line.startsWith('data:')) {
                  dataLines.push(line.slice(5).trim());
                }
              }
              if (dataLines.length > 0) {
                const rawJson = dataLines.join('\n');
                try {
                  const parsed = JSON.parse(rawJson);
                  onEvent(eventName, parsed);
                } catch {
                  onEvent(eventName, rawJson);
                }
              }
              if (eventName === 'complete') {
                stopped = true;
                onStateChange?.(false);
                return;
              }
            }
          }
        } catch {
          if (stopped || abortController.signal.aborted) break;
        }
        onStateChange?.(false);
        if (!stopped && !abortController.signal.aborted) {
          await new Promise((r) => setTimeout(r, retryDelayMs));
          retryDelayMs = Math.min(retryDelayMs * 2, 15000);
        }
      }
    };

    connect();
    return () => {
      stopped = true;
      abortController.abort();
    };
  },
};

async function download(path: string, fileName: string, allowRefreshRetry = true): Promise<void> {
  const response = await fetch(`${API_BASE}${path}`, {
    credentials: 'same-origin',
    headers: headers(),
  });
  if (response.status === 401) {
    if (allowRefreshRetry) {
      const refreshed = await performTokenRefresh();
      if (refreshed) {
        return download(path, fileName, false);
      }
    }
    setAccessToken(null);
    window.dispatchEvent(new Event('patching-auth-expired'));
  }
  if (!response.ok) throw new Error(`Download failed (${response.status})`);
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}
