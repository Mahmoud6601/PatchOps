import enum
from datetime import datetime, timedelta, timezone
from sqlalchemy import (
    Column, Integer, String, Text, Boolean, DateTime, ForeignKey, Enum, Float,
    JSON, Index, UniqueConstraint,
)
from sqlalchemy.orm import relationship
from app.database import Base


def utcnow_naive() -> datetime:
    """Return UTC for legacy database columns stored without a timezone."""
    return datetime.now(timezone.utc).replace(tzinfo=None)

class RoleEnum(str, enum.Enum):
    ADMIN = "administrator"
    OPERATOR = "operator"
    READONLY = "readonly"

class OSFamilyEnum(str, enum.Enum):
    LINUX = "linux"
    WINDOWS = "windows"

class ConnectionStatusEnum(str, enum.Enum):
    ONLINE = "online"
    OFFLINE = "offline"
    UNREACHABLE = "unreachable"

class UpdateTypeEnum(str, enum.Enum):
    DISCOVERY = "discovery"
    SECURITY = "security"
    REGULAR = "regular"
    MAJOR_UPGRADE = "major_upgrade"

class JobStatusEnum(str, enum.Enum):
    PENDING = "pending"
    RUNNING = "running"
    SUCCESS = "success"
    FAILED = "failed"
    CANCELLED = "cancelled"

class StageStatusEnum(str, enum.Enum):
    PENDING = "pending"
    RUNNING = "running"
    SUCCESS = "success"
    FAILED = "failed"
    SKIPPED = "skipped"
    UNREACHABLE = "unreachable"
    CANCELLED = "cancelled"

# User table
class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True, index=True)
    username = Column(String(50), unique=True, index=True, nullable=False)
    email = Column(String(100), unique=True, index=True, nullable=True)
    password_hash = Column(String(255), nullable=False)
    full_name = Column(String(100), nullable=True)
    role = Column(Enum(RoleEnum), default=RoleEnum.OPERATOR, nullable=False)
    is_active = Column(Boolean, default=True)
    token_version = Column(Integer, default=0, nullable=False)
    allowed_group_ids = Column(JSON, nullable=True)    # None/empty = all customer groups; list[int] = restricted
    allowed_os_families = Column(JSON, nullable=True)  # None/empty = all OS families; list["linux"|"windows"] = restricted
    created_at = Column(DateTime, default=utcnow_naive)


class RevokedToken(Base):
    __tablename__ = "revoked_tokens"
    id = Column(Integer, primary_key=True, index=True)
    jti = Column(String(64), unique=True, index=True, nullable=False)
    username = Column(String(50), index=True, nullable=False)
    expires_at = Column(DateTime, nullable=False)
    revoked_at = Column(DateTime, default=utcnow_naive, nullable=False)

# Server Group table
class ServerGroup(Base):
    __tablename__ = "server_groups"
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(50), unique=True, nullable=False)
    description = Column(String(200), nullable=True)
    default_linux_credential_id = Column(Integer, nullable=True)
    default_windows_credential_id = Column(Integer, nullable=True)
    servers = relationship("Server", back_populates="group")

# Server table
class Server(Base):
    __tablename__ = "servers"
    id = Column(Integer, primary_key=True, index=True)
    hostname = Column(String(100), index=True, nullable=False)
    ip_address = Column(String(50), unique=True, index=True, nullable=False)
    os_family = Column(Enum(OSFamilyEnum), default=OSFamilyEnum.LINUX, nullable=False)
    os_name = Column(String(100), nullable=True)
    os_version = Column(String(50), nullable=True)
    kernel_version = Column(String(100), nullable=True)
    architecture = Column(String(50), default="x86_64")
    package_manager = Column(String(50), nullable=True)
    cpu_cores = Column(Integer, default=1)
    ram_total_mb = Column(Integer, default=0)
    ram_available_mb = Column(Integer, default=0)
    disk_total_gb = Column(Float, default=0.0)
    disk_available_gb = Column(Float, default=0.0)
    connection_status = Column(Enum(ConnectionStatusEnum), default=ConnectionStatusEnum.OFFLINE, nullable=False)
    reboot_required = Column(Boolean, default=False)
    reboot_status_known = Column(Boolean, default=False, nullable=False)
    pending_updates_count = Column(Integer, default=0)
    security_updates_count = Column(Integer, default=0)
    last_discovered_at = Column(DateTime, nullable=True)
    last_updated_at = Column(DateTime, nullable=True)
    is_managed = Column(Boolean, default=True, nullable=False)
    # AWX stores the secret.  The platform keeps only the selected AWX
    # credential ID so each Windows host can use its own machine account.
    awx_credential_id = Column(Integer, nullable=True)
    winrm_cert_validation = Column(String(20), nullable=True)
    group_id = Column(Integer, ForeignKey("server_groups.id"), nullable=True)
    group = relationship("ServerGroup", back_populates="servers")
    created_at = Column(DateTime, default=utcnow_naive)

    @property
    def group_name(self) -> str | None:
        return self.group.name if self.group else None

    @property
    def discovery_fresh(self) -> bool:
        if self.last_discovered_at is None:
            return False
        from app.config import settings

        return self.last_discovered_at >= utcnow_naive() - timedelta(hours=settings.DISCOVERY_MAX_AGE_HOURS)

# Update Job table (Build)
class UpdateJob(Base):
    __tablename__ = "update_jobs"
    id = Column(Integer, primary_key=True, index=True)
    build_id = Column(String(50), unique=True, index=True, nullable=False)
    job_name = Column(String(100), nullable=False)
    update_type = Column(Enum(UpdateTypeEnum), default=UpdateTypeEnum.SECURITY, nullable=False)
    status = Column(Enum(JobStatusEnum), default=JobStatusEnum.PENDING, index=True)
    initiated_by = Column(String(50), default="system")
    awx_job_id = Column(Integer, nullable=True)
    scheduled_for = Column(DateTime, nullable=True)
    start_time = Column(DateTime, nullable=True)
    end_time = Column(DateTime, nullable=True)
    duration_seconds = Column(Integer, default=0)
    total_servers = Column(Integer, default=0)
    successful_servers = Column(Integer, default=0)
    failed_servers = Column(Integer, default=0)
    error_summary = Column(Text, nullable=True)
    raw_logs = Column(Text, nullable=True)
    major_upgrade_approved = Column(Boolean, default=False, nullable=False)
    backup_verified = Column(Boolean, default=False, nullable=False)
    overlap_approved = Column(Boolean, default=False, nullable=False)
    batch_id = Column(String(50), nullable=True, index=True)
    reboot_only = Column(Boolean, default=False, nullable=False)
    clean_cache_only = Column(Boolean, default=False, nullable=False)
    retry_of_build_id = Column(String(50), nullable=True)
    created_at = Column(DateTime, default=utcnow_naive)
    
    server_records = relationship("JobServer", back_populates="job", cascade="all, delete-orphan")
    events = relationship("JobEvent", back_populates="job", cascade="all, delete-orphan")

# Per-server Execution Record within a Job
class JobServer(Base):
    __tablename__ = "job_servers"
    id = Column(Integer, primary_key=True, index=True)
    job_id = Column(Integer, ForeignKey("update_jobs.id"), nullable=False)
    server_id = Column(Integer, ForeignKey("servers.id"), nullable=False)
    server_hostname = Column(String(100), nullable=False)
    server_ip = Column(String(50), nullable=False)
    status = Column(Enum(JobStatusEnum), default=JobStatusEnum.PENDING)
    reboot_performed = Column(Boolean, default=False)
    start_time = Column(DateTime, nullable=True)
    end_time = Column(DateTime, nullable=True)
    duration_seconds = Column(Integer, default=0)
    raw_logs = Column(Text, nullable=True)
    error_details = Column(Text, nullable=True)
    
    job = relationship("UpdateJob", back_populates="server_records")
    server = relationship("Server")
    stages = relationship("PipelineStage", back_populates="job_server", cascade="all, delete-orphan")

# Per-server AWX pipeline stage record
class PipelineStage(Base):
    __tablename__ = "pipeline_stages"
    id = Column(Integer, primary_key=True, index=True)
    job_server_id = Column(Integer, ForeignKey("job_servers.id"), nullable=False)
    stage_name = Column(String(50), nullable=False) # Discovery, Pre-check, Update, Reboot, Verification
    stage_order = Column(Integer, nullable=False)
    status = Column(Enum(StageStatusEnum), default=StageStatusEnum.PENDING)
    duration_seconds = Column(Integer, default=0)
    start_time = Column(DateTime, nullable=True)
    end_time = Column(DateTime, nullable=True)
    stage_logs = Column(Text, nullable=True)
    
    job_server = relationship("JobServer", back_populates="stages")


class JobEvent(Base):
    """Persisted, sanitized AWX event metadata used to explain real stage state."""

    __tablename__ = "job_events"
    id = Column(Integer, primary_key=True, index=True)
    job_id = Column(Integer, ForeignKey("update_jobs.id", ondelete="CASCADE"), nullable=False)
    job_server_id = Column(Integer, ForeignKey("job_servers.id", ondelete="CASCADE"), nullable=True)
    awx_event_id = Column(Integer, nullable=False)
    event_type = Column(String(80), nullable=False)
    task_name = Column(String(255), nullable=True)
    stage_name = Column(String(50), nullable=True)
    status = Column(String(30), nullable=False)
    message = Column(Text, nullable=True)
    occurred_at = Column(DateTime, default=utcnow_naive, nullable=False)

    job = relationship("UpdateJob", back_populates="events")
    job_server = relationship("JobServer")

    __table_args__ = (
        UniqueConstraint("job_id", "awx_event_id", name="uq_job_events_awx_event"),
        Index("ix_job_events_job_stage", "job_id", "stage_name"),
    )

# Installed Updates Tracker
class InstalledPatch(Base):
    __tablename__ = "installed_patches"
    id = Column(Integer, primary_key=True, index=True)
    job_id = Column(Integer, ForeignKey("update_jobs.id"), nullable=False)
    server_id = Column(Integer, ForeignKey("servers.id"), nullable=False)
    package_or_kb = Column(String(100), nullable=False)
    patch_type = Column(String(50), default="security")
    installed_at = Column(DateTime, default=utcnow_naive)

# Schedules table
class Schedule(Base):
    __tablename__ = "schedules"
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(100), nullable=False)
    update_type = Column(Enum(UpdateTypeEnum), default=UpdateTypeEnum.SECURITY)
    target_servers = Column(JSON, default=list) # List of server IDs
    target_group_id = Column(Integer, nullable=True)
    cron_expression = Column(String(50), nullable=True)
    scheduled_time = Column(DateTime, nullable=True)
    timezone = Column(String(50), default="UTC")
    maintenance_window_mins = Column(Integer, default=120)
    is_active = Column(Boolean, default=True)
    prevent_overlap = Column(Boolean, default=True)
    created_by = Column(String(50), default="system", nullable=False)
    last_run_at = Column(DateTime, nullable=True)
    next_run_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=utcnow_naive)

# Audit Log table
class AuditLog(Base):
    __tablename__ = "audit_logs"
    id = Column(Integer, primary_key=True, index=True)
    username = Column(String(50), nullable=False)
    action = Column(String(100), nullable=False)
    target_resource = Column(String(100), nullable=True)
    details = Column(Text, nullable=True)
    ip_address = Column(String(50), nullable=True)
    timestamp = Column(DateTime, default=utcnow_naive)
