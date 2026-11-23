import ipaddress
import re
from datetime import datetime
from typing import List, Literal, Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
from pydantic import BaseModel, Field, field_validator, model_validator
from app.models.models import RoleEnum, OSFamilyEnum, ConnectionStatusEnum, UpdateTypeEnum, JobStatusEnum, StageStatusEnum

_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[A-Za-z0-9-]{2,}$")


def validate_enterprise_email(value):
    if value is None:
        return None
    if isinstance(value, str):
        cleaned = value.strip().lower()
        if not cleaned:
            return None
        if len(cleaned) > 100 or not _EMAIL_RE.match(cleaned):
            raise ValueError("Enter a valid email address")
        return cleaned
    raise ValueError("Enter a valid email address")

class Token(BaseModel):
    access_token: str
    token_type: str
    role: str
    username: str

class UserLogin(BaseModel):
    username: str
    password: str

class UserCreate(BaseModel):
    username: str = Field(min_length=3, max_length=50, pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
    email: Optional[str] = None
    password: str = Field(min_length=12, max_length=72)
    full_name: Optional[str] = None
    role: RoleEnum = RoleEnum.OPERATOR
    allowed_group_ids: Optional[List[int]] = None
    allowed_os_families: Optional[List[Literal["linux", "windows"]]] = None

    @field_validator("password")
    @classmethod
    def validate_password_bytes(cls, value: str) -> str:
        if len(value.encode("utf-8")) > 72:
            raise ValueError("Password must be at most 72 UTF-8 bytes")
        return value

    @field_validator("username")
    @classmethod
    def trim_username(cls, value: str) -> str:
        return value.strip()

    @field_validator("email", mode="before")
    @classmethod
    def normalize_blank_email(cls, value):
        return validate_enterprise_email(value)


class SelfProfileUpdate(BaseModel):
    full_name: Optional[str] = None
    email: Optional[str] = None

    @field_validator("full_name", mode="before")
    @classmethod
    def normalize_full_name(cls, value):
        if isinstance(value, str):
            return value.strip() or None
        return value

    @field_validator("email", mode="before")
    @classmethod
    def normalize_email(cls, value):
        return validate_enterprise_email(value)


class SelfPasswordChange(BaseModel):
    current_password: str = Field(min_length=1, max_length=72)
    new_password: str = Field(min_length=12, max_length=72)

    @field_validator("new_password")
    @classmethod
    def validate_new_password_bytes(cls, value: str) -> str:
        if len(value.encode("utf-8")) > 72:
            raise ValueError("Password must be at most 72 UTF-8 bytes")
        return value


class UserResponse(BaseModel):
    id: int
    username: str
    email: Optional[str] = None
    full_name: Optional[str] = None
    role: RoleEnum
    is_active: bool
    allowed_group_ids: Optional[List[int]] = None
    allowed_os_families: Optional[List[str]] = None
    created_at: datetime
    class Config:
        from_attributes = True

class ServerGroupCreate(BaseModel):
    name: str = Field(min_length=1, max_length=50)
    description: Optional[str] = None
    default_linux_credential_id: Optional[int] = Field(default=None, gt=0)
    default_windows_credential_id: Optional[int] = Field(default=None, gt=0)

    @field_validator("name")
    @classmethod
    def trim_group_name(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Group name cannot be blank")
        return value

class ServerGroupUpdate(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=50)
    description: Optional[str] = None
    default_linux_credential_id: Optional[int] = None
    default_windows_credential_id: Optional[int] = None

class ServerGroupResponse(BaseModel):
    id: int
    name: str
    description: Optional[str] = None
    server_count: Optional[int] = 0
    default_linux_credential_id: Optional[int] = None
    default_windows_credential_id: Optional[int] = None
    class Config:
        from_attributes = True

class ServerCreate(BaseModel):
    hostname: str = Field(min_length=1, max_length=100, pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
    ip_address: str
    os_family: OSFamilyEnum
    os_name: Optional[str] = None
    os_version: Optional[str] = None
    awx_credential_id: Optional[int] = Field(default=None, gt=0)
    winrm_cert_validation: Optional[Literal["validate", "ignore"]] = None
    group_id: Optional[int] = None

    @field_validator("ip_address")
    @classmethod
    def validate_ip_address(cls, value: str) -> str:
        return str(ipaddress.ip_address(value.strip()))

class ServerUpdate(BaseModel):
    hostname: Optional[str] = Field(default=None, min_length=1, max_length=100, pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
    ip_address: Optional[str] = None
    os_family: Optional[OSFamilyEnum] = None
    os_name: Optional[str] = None
    os_version: Optional[str] = None
    awx_credential_id: Optional[int] = Field(default=None, gt=0)
    winrm_cert_validation: Optional[Literal["validate", "ignore"]] = None
    group_id: Optional[int] = None

    @field_validator("ip_address")
    @classmethod
    def validate_ip_address(cls, value: Optional[str]) -> Optional[str]:
        return str(ipaddress.ip_address(value.strip())) if value else value

class ServerResponse(BaseModel):
    id: int
    hostname: str
    ip_address: str
    os_family: OSFamilyEnum
    os_name: Optional[str] = None
    os_version: Optional[str] = None
    kernel_version: Optional[str] = None
    architecture: Optional[str] = None
    package_manager: Optional[str] = None
    cpu_cores: int
    ram_total_mb: int
    ram_available_mb: int
    disk_total_gb: float
    disk_available_gb: float
    connection_status: ConnectionStatusEnum
    reboot_required: bool
    reboot_status_known: bool = False
    pending_updates_count: int
    security_updates_count: int
    last_discovered_at: Optional[datetime] = None
    discovery_fresh: bool = False
    last_updated_at: Optional[datetime] = None
    is_managed: bool = True
    awx_credential_id: Optional[int] = None
    winrm_cert_validation: Optional[str] = None
    group_id: Optional[int] = None
    group_name: Optional[str] = None
    created_at: datetime
    class Config:
        from_attributes = True


class AWXMachineCredentialResponse(BaseModel):
    """Safe metadata for a selectable AWX Machine credential.

    Neither this endpoint nor the database ever returns a password or SSH key.
    """

    id: int
    name: str
    os_compatibility: str = "all"  # "windows", "linux", "all"
    description: Optional[str] = None

class StageResponse(BaseModel):
    id: int
    stage_name: str
    stage_order: int
    status: StageStatusEnum
    duration_seconds: int
    start_time: Optional[datetime] = None
    end_time: Optional[datetime] = None
    stage_logs: Optional[str] = None
    class Config:
        from_attributes = True

class JobServerResponse(BaseModel):
    id: int
    server_id: int
    server_hostname: str
    server_ip: str
    status: JobStatusEnum
    reboot_performed: bool
    duration_seconds: int
    start_time: Optional[datetime] = None
    end_time: Optional[datetime] = None
    raw_logs: Optional[str] = None
    stages: List[StageResponse] = []
    error_details: Optional[str] = None
    class Config:
        from_attributes = True

class JobCreate(BaseModel):
    job_name: str = Field(min_length=1, max_length=100)
    update_type: UpdateTypeEnum
    server_ids: List[int] = Field(min_length=1)
    confirm_major_upgrade: Optional[bool] = False
    backup_verified: Optional[bool] = False
    allow_overlap: bool = False
    reboot_only: Optional[bool] = False
    clean_cache_only: Optional[bool] = False

    @field_validator("job_name")
    @classmethod
    def trim_job_name(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Job name cannot be blank")
        return value

class JobResponse(BaseModel):
    id: int
    build_id: str
    job_name: str
    update_type: UpdateTypeEnum
    status: JobStatusEnum
    initiated_by: str
    awx_job_id: Optional[int] = None
    scheduled_for: Optional[datetime] = None
    start_time: Optional[datetime] = None
    end_time: Optional[datetime] = None
    duration_seconds: int
    total_servers: int
    successful_servers: int
    failed_servers: int
    major_upgrade_approved: bool = False
    backup_verified: bool = False
    overlap_approved: bool = False
    reboot_only: bool = False
    clean_cache_only: bool = False
    retry_of_build_id: Optional[str] = None
    created_at: datetime
    batch_id: Optional[str] = None
    batch_build_ids: Optional[List[str]] = None
    batch_count: Optional[int] = 1
    class Config:
        from_attributes = True

class JobDetailResponse(JobResponse):
    error_summary: Optional[str] = None
    raw_logs: Optional[str] = None
    server_records: List[JobServerResponse] = []
    batch_sister_jobs: Optional[List[JobResponse]] = None
    batch_server_records: Optional[List[JobServerResponse]] = None
    batch_active_servers: Optional[int] = None
    batch_total_servers: Optional[int] = None
    batch_successful_servers: Optional[int] = None
    batch_failed_servers: Optional[int] = None
    class Config:
        from_attributes = True

class ScheduleCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    update_type: UpdateTypeEnum
    target_servers: List[int] = Field(default_factory=list)
    target_group_id: Optional[int] = None
    cron_expression: Optional[str] = None
    scheduled_time: Optional[datetime] = None
    timezone: str = "UTC"
    maintenance_window_mins: int = 120
    prevent_overlap: bool = True
    is_active: bool = True

    @field_validator("name")
    @classmethod
    def trim_name(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Schedule name cannot be blank")
        return value

    @field_validator("timezone")
    @classmethod
    def validate_timezone(cls, value: str) -> str:
        try:
            ZoneInfo(value)
        except ZoneInfoNotFoundError as exc:
            raise ValueError("Unknown IANA timezone") from exc
        return value

    @model_validator(mode="after")
    def validate_schedule_target_and_trigger(self):
        if bool(self.target_servers) == (self.target_group_id is not None):
            raise ValueError("Select either one or more servers or a server group")
        if bool(self.cron_expression) == (self.scheduled_time is not None):
            raise ValueError("Provide either a recurring cron expression or a one-time scheduled time")
        if self.update_type == UpdateTypeEnum.MAJOR_UPGRADE:
            raise ValueError("Major OS upgrades must be launched as individually approved jobs")
        if self.maintenance_window_mins < 1 or self.maintenance_window_mins > 1440:
            raise ValueError("Maintenance window must be between 1 and 1440 minutes")
        return self


class ScheduleUpdate(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=100)
    update_type: Optional[UpdateTypeEnum] = None
    target_servers: Optional[List[int]] = None
    target_group_id: Optional[int] = None
    cron_expression: Optional[str] = None
    scheduled_time: Optional[datetime] = None
    timezone: Optional[str] = None
    maintenance_window_mins: Optional[int] = Field(default=None, ge=1, le=1440)
    prevent_overlap: Optional[bool] = None
    is_active: Optional[bool] = None

    @field_validator("name")
    @classmethod
    def trim_optional_name(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return value
        value = value.strip()
        if not value:
            raise ValueError("Schedule name cannot be blank")
        return value

    @field_validator("timezone")
    @classmethod
    def validate_timezone(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        try:
            ZoneInfo(value)
        except ZoneInfoNotFoundError as exc:
            raise ValueError("Unknown IANA timezone") from exc
        return value


class JobEventResponse(BaseModel):
    id: int
    awx_event_id: int
    event_type: str
    task_name: Optional[str] = None
    stage_name: Optional[str] = None
    status: str
    message: Optional[str] = None
    occurred_at: datetime

    class Config:
        from_attributes = True

class ScheduleResponse(BaseModel):
    id: int
    name: str
    update_type: UpdateTypeEnum
    target_servers: List[int] = []
    target_group_id: Optional[int] = None
    cron_expression: Optional[str] = None
    scheduled_time: Optional[datetime] = None
    timezone: str
    maintenance_window_mins: int
    prevent_overlap: bool
    is_active: bool
    created_by: str = "system"
    last_run_at: Optional[datetime] = None
    next_run_at: Optional[datetime] = None
    created_at: datetime
    class Config:
        from_attributes = True

class CustomerSummary(BaseModel):
    id: Optional[int] = None
    name: str
    description: Optional[str] = None
    total_servers: int = 0
    online_servers: int = 0
    offline_servers: int = 0
    windows_servers: int = 0
    linux_servers: int = 0
    pending_updates_count: int = 0
    security_updates_count: int = 0
    reboot_required_count: int = 0
    compliance_rate: float = 100.0
    health_status: str = "healthy"  # "healthy", "warning", "critical"

class DashboardSummary(BaseModel):
    total_servers: int
    online_servers: int
    offline_servers: int
    servers_requiring_updates: int
    security_updates_available: int
    servers_requiring_reboot: int
    pending_jobs: int
    running_jobs: int
    successful_jobs: int
    failed_jobs: int
    recent_builds: List[JobResponse] = []
    customer_summaries: List[CustomerSummary] = []

class AuditLogResponse(BaseModel):
    id: int
    username: str
    action: str
    target_resource: Optional[str] = None
    details: Optional[str] = None
    ip_address: Optional[str] = None
    timestamp: datetime
    class Config:
        from_attributes = True


class InstalledPatchResponse(BaseModel):
    id: int
    job_id: int
    build_id: Optional[str] = None
    server_id: int
    server_hostname: Optional[str] = None
    package_or_kb: str
    patch_type: str
    installed_at: datetime

    @field_validator("package_or_kb", mode="before")
    @classmethod
    def format_windows_kb_list(cls, value):
        if isinstance(value, str):
            trimmed = value.strip()
            if trimmed.startswith("[") and trimmed.endswith("]"):
                nums = re.findall(r"\d{5,}", trimmed)
                if nums:
                    return ", ".join(f"KB{n}" for n in nums)
        return value

    class Config:
        from_attributes = True

