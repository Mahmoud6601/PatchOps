export type OSFamily = 'linux' | 'windows';
export type ConnectionStatus = 'online' | 'offline' | 'unreachable';
export type UpdateType = 'discovery' | 'security' | 'regular' | 'major_upgrade';
export type JobStatus = 'pending' | 'running' | 'success' | 'failed' | 'cancelled';
export type StageStatus = 'pending' | 'running' | 'success' | 'failed' | 'skipped' | 'unreachable' | 'cancelled';

export interface User {
  id: number;
  username: string;
  email?: string;
  full_name?: string;
  role: 'administrator' | 'operator' | 'readonly';
  is_active?: boolean;
  allowed_group_ids?: number[] | null;
  allowed_os_families?: ('linux' | 'windows')[] | null;
  created_at?: string;
}

export interface Server {
  id: number;
  hostname: string;
  ip_address: string;
  os_family: OSFamily;
  os_name?: string;
  os_version?: string;
  kernel_version?: string;
  architecture?: string;
  package_manager?: string;
  cpu_cores: number;
  ram_total_mb: number;
  ram_available_mb: number;
  disk_total_gb: number;
  disk_available_gb: number;
  connection_status: ConnectionStatus;
  reboot_required: boolean;
  reboot_status_known: boolean;
  pending_updates_count: number;
  security_updates_count: number;
  last_discovered_at?: string;
  discovery_fresh: boolean;
  last_updated_at?: string;
  awx_credential_id?: number | null;
  winrm_cert_validation?: 'validate' | 'ignore' | null;
  group_id?: number | null;
  group_name?: string;
  created_at: string;
  is_managed: boolean;
}

export interface AwxMachineCredential {
  id: number;
  name: string;
  os_compatibility?: 'linux' | 'windows' | 'all';
  description?: string;
}

export interface ServerGroup {
  id: number;
  name: string;
  description?: string;
  server_count: number;
  default_linux_credential_id?: number | null;
  default_windows_credential_id?: number | null;
}

export interface PipelineStage {
  id: number;
  stage_name: string;
  stage_order: number;
  status: StageStatus;
  duration_seconds: number;
  start_time?: string;
  end_time?: string;
  stage_logs?: string;
}

export interface JobServer {
  id: number;
  job_id?: number;
  server_id: number;
  server_hostname: string;
  server_ip: string;
  status: JobStatus;
  reboot_performed: boolean;
  duration_seconds: number;
  start_time?: string;
  end_time?: string;
  stages: PipelineStage[];
  error_details?: string;
  raw_logs?: string;
}

export interface UpdateJob {
  id: number;
  build_id: string;
  job_name: string;
  update_type: UpdateType;
  status: JobStatus;
  initiated_by: string;
  awx_job_id?: number | null;
  start_time?: string;
  end_time?: string;
  duration_seconds: number;
  total_servers: number;
  successful_servers: number;
  failed_servers: number;
  created_at: string;
  error_summary?: string;
  raw_logs?: string;
  scheduled_for?: string;
  major_upgrade_approved: boolean;
  backup_verified: boolean;
  overlap_approved: boolean;
  batch_id?: string | null;
  batch_build_ids?: string[];
  batch_count?: number;
  batch_sister_jobs?: UpdateJob[];
  batch_server_records?: JobServer[];
  batch_active_servers?: number;
  batch_total_servers?: number;
  batch_successful_servers?: number;
  batch_failed_servers?: number;
  reboot_only?: boolean;
  clean_cache_only?: boolean;
  retry_of_build_id?: string | null;
  server_records?: JobServer[];
}

export interface JobEvent {
  id: number;
  awx_event_id: number;
  event_type: string;
  task_name?: string;
  stage_name?: string;
  status: string;
  message?: string;
  occurred_at: string;
}

export interface Schedule {
  id: number;
  name: string;
  update_type: UpdateType;
  target_servers: number[];
  target_group_id?: number | null;
  cron_expression?: string | null;
  scheduled_time?: string | null;
  timezone: string;
  maintenance_window_mins: number;
  prevent_overlap: boolean;
  is_active: boolean;
  last_run_at?: string | null;
  next_run_at?: string | null;
  created_by?: string;
  created_at: string;
}

export interface CustomerSummary {
  id?: number | null;
  name: string;
  description?: string;
  total_servers: number;
  online_servers: number;
  offline_servers: number;
  windows_servers: number;
  linux_servers: number;
  pending_updates_count: number;
  security_updates_count: number;
  reboot_required_count: number;
  compliance_rate: number;
  health_status: 'healthy' | 'warning' | 'critical';
}

export interface DashboardSummary {
  total_servers: number;
  online_servers: number;
  offline_servers: number;
  servers_requiring_updates: number;
  security_updates_available: number;
  servers_requiring_reboot: number;
  pending_jobs: number;
  running_jobs: number;
  successful_jobs: number;
  failed_jobs: number;
  recent_builds: UpdateJob[];
  customer_summaries?: CustomerSummary[];
}

export interface AuditLog {
  id: number;
  username: string;
  action: string;
  target_resource?: string;
  details?: string;
  ip_address?: string;
  timestamp: string;
}

export interface InstalledPatch {
  id: number;
  job_id: number;
  build_id?: string | null;
  server_id: number;
  server_hostname?: string | null;
  package_or_kb: string;
  patch_type: string;
  installed_at: string;
}
