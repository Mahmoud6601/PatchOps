import json
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, Iterable

from sqlalchemy.orm import Session

from app.models.models import (
    AuditLog,
    ConnectionStatusEnum,
    InstalledPatch,
    JobEvent,
    JobServer,
    JobStatusEnum,
    OSFamilyEnum,
    PipelineStage,
    Server,
    StageStatusEnum,
    UpdateJob,
    UpdateTypeEnum,
)
from app.services.pipeline_engine import (
    STAGE_NAMES,
    event_applies_to_os,
    map_task_to_stage,
    status_for_awx_event,
)


def utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def generate_run_id() -> str:
    return f"RUN-{uuid.uuid4().hex[:12].upper()}"


def create_job_record(
    db: Session,
    *,
    job_name: str,
    update_type: UpdateTypeEnum,
    servers: list[Server],
    initiated_by: str,
    major_upgrade_approved: bool = False,
    backup_verified: bool = False,
    overlap_approved: bool = False,
    scheduled_for: datetime | None = None,
    reboot_only: bool = False,
    clean_cache_only: bool = False,
    batch_id: str | None = None,
    retry_of_build_id: str | None = None,
) -> UpdateJob:
    job = UpdateJob(
        build_id=generate_run_id(),
        job_name=job_name,
        update_type=update_type,
        status=JobStatusEnum.PENDING,
        initiated_by=initiated_by,
        total_servers=len(servers),
        major_upgrade_approved=major_upgrade_approved,
        backup_verified=backup_verified,
        overlap_approved=overlap_approved,
        scheduled_for=scheduled_for,
        reboot_only=reboot_only,
        clean_cache_only=clean_cache_only,
        batch_id=batch_id,
        retry_of_build_id=retry_of_build_id,
    )
    db.add(job)
    db.flush()

    for server in servers:
        record = JobServer(
            job_id=job.id,
            server_id=server.id,
            server_hostname=server.hostname,
            server_ip=server.ip_address,
            status=JobStatusEnum.PENDING,
        )
        db.add(record)
        db.flush()
        if update_type == UpdateTypeEnum.DISCOVERY:
            active_stages = ["Discovery"]
        elif reboot_only:
            active_stages = ["Reboot"]
        elif clean_cache_only:
            active_stages = ["Update"]
        else:
            active_stages = STAGE_NAMES

        for order, stage_name in enumerate(active_stages, start=1):
            db.add(PipelineStage(
                job_server_id=record.id,
                stage_name=stage_name,
                stage_order=order,
                status=StageStatusEnum.PENDING,
            ))

    db.add(AuditLog(
        username=initiated_by,
        action="LAUNCH_JOB",
        target_resource=job.build_id,
        details=(
            f"Queued {update_type.value} job for {len(servers)} server(s)"
            + (" with administrator-approved overlap" if overlap_approved else "")
        ),
    ))
    return job


create_update_job = create_job_record


def _message_for_event(event: Dict[str, Any]) -> str:
    data = event.get("event_data") or {}
    result = data.get("res") or {}
    message = result.get("msg") or result.get("stderr") or result.get("stdout") or event.get("event_display") or ""
    if isinstance(message, (dict, list)):
        message = json.dumps(message, ensure_ascii=False, default=str)
    return str(message).strip()[:4000]


def _append_text(current: str | None, line: str, limit: int = 100_000) -> str:
    text = f"{current}\n{line}" if current else line
    return text[-limit:]


def _parse_count(value: Any) -> int | None:
    if value is None or str(value).strip().lower() in {"", "none", "null", "unknown"}:
        return None
    try:
        return max(0, int(value))
    except (TypeError, ValueError):
        return None


def _parse_bool(value: Any) -> bool | None:
    if isinstance(value, bool):
        return value
    if isinstance(value, int) and value in (0, 1):
        return bool(value)
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"true", "yes", "1", "on"}:
            return True
        if normalized in {"false", "no", "0", "off"}:
            return False
    return None


def _set_discovered_values(server: Server, result: Dict[str, Any]) -> None:
    facts = result.get("ansible_facts") or {}
    message = result.get("msg") or {}
    if isinstance(message, list):
        message = next((item for item in message if isinstance(item, dict)), {})
    if not isinstance(message, dict):
        message = {}

    os_name = message.get("os_name")
    distribution = facts.get("ansible_distribution")
    version = facts.get("ansible_distribution_version")
    if os_name:
        server.os_name = str(os_name)[:100]
    elif distribution:
        server.os_name = str(distribution)[:100]
    if version:
        server.os_version = str(version)[:50]
    elif message.get("os_version"):
        server.os_version = str(message["os_version"])[:50]

    family = str(facts.get("ansible_os_family") or "").lower()
    system = str(facts.get("ansible_system") or "").lower()
    if family == "windows" or system == "win32nt":
        server.os_family = OSFamilyEnum.WINDOWS
        server.package_manager = "windows_update"
    elif family:
        server.os_family = OSFamilyEnum.LINUX
        server.package_manager = {
            "debian": "apt",
            "redhat": "dnf",
            "suse": "zypper",
        }.get(family)

    kernel = facts.get("ansible_kernel") or message.get("kernel")
    architecture = facts.get("ansible_architecture") or message.get("arch")
    cpu_count = facts.get("ansible_processor_vcpus") or message.get("cpu_cores")
    memory_total = facts.get("ansible_memtotal_mb") or message.get("ram_mb")
    memory_available = facts.get("ansible_memavailable_mb") or facts.get("ansible_memfree_mb")
    mounts = facts.get("ansible_mounts") or []
    root_mount = next((mount for mount in mounts if mount.get("mount") == "/"), {})
    disk_total = root_mount.get("size_total")
    disk_available = root_mount.get("size_available")

    if kernel:
        server.kernel_version = str(kernel)[:100]
    if architecture:
        server.architecture = str(architecture)[:50]
    if cpu_count is not None:
        server.cpu_cores = int(cpu_count)
    if memory_total is not None:
        server.ram_total_mb = int(memory_total)
    if memory_available is not None:
        server.ram_available_mb = int(memory_available)
    if disk_total is not None:
        server.disk_total_gb = float(disk_total) / (1024 ** 3)
    if disk_available is not None:
        server.disk_available_gb = float(disk_available) / (1024 ** 3)

    reboot_required = _parse_bool(message.get("reboot_required"))
    if reboot_required is not None:
        server.reboot_required = reboot_required
        known = _parse_bool(message.get("reboot_status_known"))
        server.reboot_status_known = True if known is None else known
    elif facts.get("patching_reboot_required") is not None:
        server.reboot_required = _parse_bool(facts["patching_reboot_required"]) or False
        server.reboot_status_known = True

    pending_count = message.get("pending_updates", message.get("updates_found", message.get("updates_found_count")))
    if pending_count is None:
        pending_count = result.get("found_update_count")
    parsed_pending = _parse_count(pending_count)
    if parsed_pending is not None:
        server.pending_updates_count = parsed_pending
    parsed_security = _parse_count(message.get("security_updates"))
    if parsed_security is not None:
        server.security_updates_count = parsed_security
    if message.get("package_manager"):
        server.package_manager = str(message["package_manager"])[:50]

    server.connection_status = ConnectionStatusEnum.ONLINE


def _set_verified_values(server: Server, result: Dict[str, Any]) -> None:
    message = result.get("msg") or {}
    if isinstance(message, list):
        message = next((item for item in message if isinstance(item, dict)), {})
    if not isinstance(message, dict):
        message = {}

    pending = _parse_count(message.get("pending_updates"))
    security = _parse_count(message.get("security_updates"))
    if pending is not None:
        server.pending_updates_count = pending
    if security is not None:
        server.security_updates_count = security
    kernel = message.get("kernel")
    if kernel:
        server.kernel_version = str(kernel)[:100]
    os_name = message.get("os_name")
    if os_name:
        server.os_name = str(os_name)[:100]
    os_version = message.get("os_version")
    if os_version:
        server.os_version = str(os_version)[:50]
    reboot_required = _parse_bool(message.get("reboot_required"))
    if reboot_required is not None:
        server.reboot_required = reboot_required
        known = _parse_bool(message.get("reboot_status_known"))
        server.reboot_status_known = True if known is None else known
    elif _parse_bool(message.get("reboot_performed")) is True:
        server.reboot_required = False
        server.reboot_status_known = True
    server.connection_status = ConnectionStatusEnum.ONLINE


def _store_installed_patches(db: Session, job: UpdateJob, job_server: JobServer,
                             result: Dict[str, Any]) -> None:
    updates = result.get("updates")
    if updates is None and isinstance(result.get("msg"), dict):
        updates = result["msg"].get("updates")
    if isinstance(updates, dict):
        items = updates.items()
    elif isinstance(updates, list):
        items = enumerate(updates)
    else:
        return
    for update_key, update in items:
        if isinstance(update, dict):
            raw_kb = update.get("kb")
            if isinstance(raw_kb, list) and raw_kb:
                kb_label = ", ".join(
                    f"KB{str(item).lstrip('KkBb')}" if str(item).lstrip("KkBb").isdigit() else str(item)
                    for item in raw_kb if item
                )
                title = str(update.get("title") or "").strip()
                identifier = f"{kb_label} — {title}" if (kb_label and title) else (kb_label or title)
            else:
                identifier = raw_kb or update.get("id") or update.get("title") or update.get("name") or update_key
        elif isinstance(update, (str, int)):
            identifier = update
        else:
            continue
        if not identifier:
            continue
        exists = db.query(InstalledPatch).filter(
            InstalledPatch.job_id == job.id,
            InstalledPatch.server_id == job_server.server_id,
            InstalledPatch.package_or_kb == str(identifier)[:100],
        ).first()
        if not exists:
            db.add(InstalledPatch(
                job_id=job.id,
                server_id=job_server.server_id,
                package_or_kb=str(identifier)[:100],
                patch_type=job.update_type.value,
            ))


def _summary_count(summary: Dict[str, Any], *keys: str) -> int:
    for key in keys:
        value = summary.get(key)
        if value is None:
            continue
        try:
            return max(0, int(value))
        except (TypeError, ValueError):
            continue
    return 0


def _set_stage_status(
    stage: PipelineStage,
    status: StageStatusEnum,
    *,
    start_time: datetime | None = None,
    end_time: datetime | None = None,
    now: datetime | None = None,
) -> None:
    """Set a live stage state and keep its duration internally consistent."""
    current_now = now or utcnow()
    stage.status = status
    if status == StageStatusEnum.PENDING:
        stage.start_time = None
        stage.end_time = None
        stage.duration_seconds = 0
        return
    if status == StageStatusEnum.SKIPPED:
        if not stage.start_time:
            stage.duration_seconds = 0
        return
    if status == StageStatusEnum.RUNNING:
        stage.start_time = stage.start_time or start_time or current_now
        stage.end_time = None
        stage.duration_seconds = max(0, int((current_now - stage.start_time).total_seconds()))
        return
    # Terminal states: SUCCESS, FAILED, UNREACHABLE, CANCELLED
    stage.start_time = stage.start_time or start_time or current_now
    if not stage.end_time:
        stage.end_time = end_time or current_now
    if stage.start_time and stage.end_time:
        stage.duration_seconds = max(0, int(round((stage.end_time - stage.start_time).total_seconds())))


def _reconcile_live_stage_states(db: Session, record: JobServer) -> None:
    """Project persisted AWX task events onto an ordered pipeline matrix.

    A stage remains *running* until AWX starts a later stage.  This avoids
    treating the first successful task inside a multi-task stage as completion,
    while guaranteeing that stage N+1 is never displayed as running before
    stage N is terminal.
    """
    now = utcnow()
    stages = sorted(record.stages, key=lambda stage: stage.stage_order)
    events = db.query(JobEvent).filter(
        JobEvent.job_server_id == record.id,
        JobEvent.stage_name.isnot(None),
        JobEvent.status.in_(("running", "success", "failed", "unreachable", "skipped")),
    ).order_by(JobEvent.occurred_at.asc(), JobEvent.id.asc()).all()
    events_by_stage = {
        stage.stage_name: [event for event in events if event.stage_name == stage.stage_name]
        for stage in stages
    }
    touched = [stage for stage in stages if events_by_stage[stage.stage_name]]
    if not touched:
        return

    current_order = max(stage.stage_order for stage in touched)
    pipeline_blocked = False
    for stage in stages:
        stage_events = events_by_stage[stage.stage_name]
        statuses = {event.status for event in stage_events}
        terminal_statuses = {event.status for event in stage_events if event.status in ("success", "failed", "unreachable", "skipped")}
        st_start = min((e.occurred_at for e in stage_events), default=None)
        st_end = max((e.occurred_at for e in stage_events), default=None)

        if pipeline_blocked:
            _set_stage_status(stage, StageStatusEnum.SKIPPED, now=now)
            continue
        if "unreachable" in terminal_statuses:
            _set_stage_status(stage, StageStatusEnum.UNREACHABLE, start_time=st_start, end_time=st_end, now=now)
            pipeline_blocked = True
            continue
        if "failed" in terminal_statuses:
            _set_stage_status(stage, StageStatusEnum.FAILED, start_time=st_start, end_time=st_end, now=now)
            pipeline_blocked = True
            continue
        if stage.stage_order < current_order:
            # AWX has begun a later stage, so this one is complete.  A stage
            # containing only conditional skips stays skipped; otherwise it
            # completed successfully.
            desired = StageStatusEnum.SUCCESS if ("success" in terminal_statuses) else StageStatusEnum.SKIPPED
            _set_stage_status(stage, desired, start_time=st_start, end_time=st_end, now=now)
        elif stage.stage_order == current_order:
            if terminal_statuses == {"skipped"}:
                _set_stage_status(stage, StageStatusEnum.SKIPPED, now=now)
            elif "success" in terminal_statuses and not any(e.status == "running" for e in stage_events):
                _set_stage_status(stage, StageStatusEnum.SUCCESS, start_time=st_start, end_time=st_end, now=now)
            else:
                _set_stage_status(stage, StageStatusEnum.RUNNING, start_time=st_start, now=now)
        else:
            _set_stage_status(stage, StageStatusEnum.PENDING, now=now)


def process_awx_events(db: Session, job: UpdateJob, events: Iterable[Dict[str, Any]]) -> None:
    by_host = {record.server_hostname.casefold(): record for record in job.server_records}
    stages_by_server = {
        record.id: {stage.stage_name: stage for stage in record.stages}
        for record in job.server_records
    }

    for event in events:
        event_id = event.get("id")
        if event_id is None:
            continue
        if db.query(JobEvent.id).filter(
            JobEvent.job_id == job.id,
            JobEvent.awx_event_id == int(event_id),
        ).first():
            continue

        event_data = event.get("event_data") or {}
        task_name = str(event_data.get("task") or event.get("event_display") or "")[:255]
        host = event_data.get("host")
        record = by_host.get(str(host).casefold()) if host else None
        stage_name = map_task_to_stage(task_name)
        event_type = str(event.get("event") or "unknown")
        event_status = status_for_awx_event(event_type) or "info"
        message = _message_for_event(event)

        created_str = event.get("created")
        event_time = utcnow()
        if created_str:
            try:
                clean_iso = str(created_str).replace("Z", "+00:00")
                event_time = datetime.fromisoformat(clean_iso).astimezone(timezone.utc).replace(tzinfo=None)
            except Exception:
                event_time = utcnow()

        # Store non-applicable events without associating them with the host.
        # This keeps AWX event de-duplication intact without letting skipped
        # Linux tasks alter a Windows host's logs or stage matrix (or vice
        # versa).
        if record and not event_applies_to_os(event_data, record.server.os_family.value):
            db.add(JobEvent(
                job_id=job.id,
                job_server_id=None,
                awx_event_id=int(event_id),
                event_type=event_type[:80],
                task_name=task_name or None,
                stage_name=None,
                status=event_status,
                message=message or None,
                occurred_at=event_time,
            ))
            continue

        db.add(JobEvent(
            job_id=job.id,
            job_server_id=record.id if record else None,
            awx_event_id=int(event_id),
            event_type=event_type[:80],
            task_name=task_name or None,
            stage_name=stage_name,
            status=event_status,
            message=message or None,
            occurred_at=event_time,
        ))

        if record:
            record.raw_logs = _append_text(record.raw_logs, f"{event_status.upper():<11} {task_name} {message}".strip())
            stage = stages_by_server[record.id].get(stage_name) if stage_name else None
            if stage:
                if event_status in ("failed", "unreachable"):
                    record.status = JobStatusEnum.FAILED
                    record.error_details = message or f"AWX event: {event_type}"
                if event_status == "skipped":
                    stage.stage_logs = _append_text(stage.stage_logs, f"SKIPPED {task_name}")

                if event_status == "success":
                    stage.stage_logs = _append_text(stage.stage_logs, f"SUCCESS {task_name} {message}".strip())
                elif event_status in ("failed", "unreachable"):
                    stage.stage_logs = _append_text(stage.stage_logs, f"{event_status.upper()} {task_name} {message}".strip())

            result = event_data.get("res") or {}
            message_payload = result.get("msg")
            if (
                stage_name == "Discovery"
                and event_status == "success"
                and isinstance(message_payload, dict)
                and any(key in message_payload for key in ("os_name", "pending_updates", "package_manager"))
            ):
                _set_discovered_values(record.server, result)
            elif (
                stage_name == "Verification"
                and event_status == "success"
                and not getattr(job, "reboot_only", False)
                and not getattr(job, "clean_cache_only", False)
                and isinstance(message_payload, dict)
                and message_payload.get("status") == "Success"
            ):
                _set_verified_values(record.server, result)
            elif stage_name == "Reboot" and (
                result.get("rebooted")
                or result.get("changed")
                or (isinstance(message_payload, dict) and _parse_bool(message_payload.get("reboot_performed")) is True)
            ):
                record.reboot_performed = True

            if stage_name == "Update" and job.update_type not in (UpdateTypeEnum.DISCOVERY, UpdateTypeEnum.MAJOR_UPGRADE):
                _store_installed_patches(db, job, record, result)

        if event_status == "unreachable" and record:
            record.server.connection_status = ConnectionStatusEnum.UNREACHABLE
        elif event_status in ("running", "success") and record:
            record.server.connection_status = ConnectionStatusEnum.ONLINE

    db.flush()
    for record in job.server_records:
        _reconcile_live_stage_states(db, record)
    db.flush()


def finalize_awx_job(db: Session, job: UpdateJob, awx_status: str,
                     host_summaries: list[Dict[str, Any]], stdout: str) -> None:
    now = utcnow()
    by_host: dict[str, Dict[str, Any]] = {}
    for summary in host_summaries:
        name = summary.get("host_name") or summary.get("host")
        if name:
            by_host[str(name).casefold()] = summary

    job.raw_logs = (stdout or "")[-1_000_000:]
    job.end_time = now
    if job.start_time:
        job.duration_seconds = max(0, int((now - job.start_time).total_seconds()))

    failed_servers = 0
    successful_servers = 0
    for record in job.server_records:
        summary = by_host.get(record.server_hostname.casefold(), {})
        # AWX exposes this as `failures` in job_host_summaries; accept `failed`
        # too for controller versions or integrations that use that alias.
        failed_count = _summary_count(summary, "failures", "failed")
        unreachable_count = _summary_count(summary, "dark", "unreachable")
        events = db.query(JobEvent).filter(
            JobEvent.job_server_id == record.id,
            JobEvent.status.in_(["success", "failed", "unreachable", "skipped", "running"]),
        ).all()
        event_failures = [e for e in events if e.status in ("failed", "unreachable")]
        if job.update_type == UpdateTypeEnum.DISCOVERY:
            completion_stage = "Discovery"
        elif getattr(job, "reboot_only", False):
            completion_stage = "Reboot"
        elif getattr(job, "clean_cache_only", False):
            completion_stage = "Update"
        else:
            completion_stage = "Verification"

        completed_pipeline = any(
            e.status == "success" and e.stage_name == completion_stage for e in events
        )

        if failed_count or unreachable_count or event_failures:
            record.status = JobStatusEnum.FAILED
            failed_servers += 1
            if not record.error_details:
                record.error_details = "Host reported failed tasks" if failed_count else "Host was unreachable from AWX"
        elif completed_pipeline:
            record.status = JobStatusEnum.SUCCESS
            successful_servers += 1
        elif awx_status == "canceled":
            record.status = JobStatusEnum.CANCELLED
        else:
            record.status = JobStatusEnum.FAILED
            failed_servers += 1
            record.error_details = record.error_details or "AWX did not report successful completion of the required pipeline stage"

        if unreachable_count or any(e.status == "unreachable" for e in events):
            record.server.connection_status = ConnectionStatusEnum.UNREACHABLE
        elif any(e.status in ("running", "success") for e in events):
            record.server.connection_status = ConnectionStatusEnum.ONLINE

        record.end_time = now
        if record.start_time:
            record.duration_seconds = max(0, int((now - record.start_time).total_seconds()))

        pipeline_blocked = False
        for stage in sorted(record.stages, key=lambda current: current.stage_order):
            stage_events = [e for e in events if e.stage_name == stage.stage_name]
            statuses = {event.status for event in stage_events}
            terminal_statuses = {event.status for event in stage_events if event.status in ("success", "failed", "unreachable", "skipped")}
            st_start = min((e.occurred_at for e in stage_events), default=None)
            st_end = max((e.occurred_at for e in stage_events), default=None)

            if pipeline_blocked:
                _set_stage_status(stage, StageStatusEnum.SKIPPED, now=now)
                continue
            if "unreachable" in terminal_statuses:
                _set_stage_status(stage, StageStatusEnum.UNREACHABLE, start_time=st_start, end_time=st_end, now=now)
                pipeline_blocked = True
            elif "failed" in terminal_statuses:
                _set_stage_status(stage, StageStatusEnum.FAILED, start_time=st_start, end_time=st_end, now=now)
                pipeline_blocked = True
            elif "success" in terminal_statuses:
                _set_stage_status(stage, StageStatusEnum.SUCCESS, start_time=st_start, end_time=st_end, now=now)
            elif terminal_statuses == {"skipped"} or ("skipped" in terminal_statuses and "running" not in statuses):
                _set_stage_status(stage, StageStatusEnum.SKIPPED, start_time=st_start, end_time=st_end, now=now)
            elif "running" in statuses:
                if awx_status == "canceled":
                    _set_stage_status(stage, StageStatusEnum.CANCELLED, start_time=st_start, end_time=st_end, now=now)
                else:
                    _set_stage_status(stage, StageStatusEnum.FAILED, start_time=st_start, end_time=st_end, now=now)
                    stage.stage_logs = _append_text(stage.stage_logs, "AWX job ended before the running task produced a result")
                    pipeline_blocked = True
            else:
                _set_stage_status(stage, StageStatusEnum.SKIPPED, now=now)

        server = record.server
        if getattr(job, "reboot_only", False) and record.status == JobStatusEnum.SUCCESS and server:
            server.reboot_required = False
            server.reboot_status_known = True
            server.connection_status = ConnectionStatusEnum.ONLINE
        elif job.update_type == UpdateTypeEnum.DISCOVERY and record.status == JobStatusEnum.SUCCESS:
            server.last_discovered_at = now
            server.connection_status = ConnectionStatusEnum.ONLINE
        elif job.update_type == UpdateTypeEnum.DISCOVERY:
            server.last_discovered_at = None
            server.pending_updates_count = 0
            server.security_updates_count = 0
            server.reboot_required = False
            server.reboot_status_known = False
            if unreachable_count or any(e.status == "unreachable" for e in events):
                server.connection_status = ConnectionStatusEnum.UNREACHABLE
            elif any(e.status in ("running", "success") for e in events):
                server.connection_status = ConnectionStatusEnum.ONLINE
            else:
                server.connection_status = ConnectionStatusEnum.OFFLINE
        elif record.status == JobStatusEnum.SUCCESS and server:
            server.last_updated_at = now

    unrepresented_targets = max(0, job.total_servers - len(job.server_records))
    if unrepresented_targets:
        failed_servers += unrepresented_targets
        job.error_summary = (
            f"{unrepresented_targets} target(s) have no persisted per-server AWX record; "
            "the job cannot be reported as successful"
        )

    job.successful_servers = successful_servers
    job.failed_servers = failed_servers
    if awx_status == "canceled":
        job.status = JobStatusEnum.CANCELLED
    elif awx_status == "successful" and failed_servers == 0:
        job.status = JobStatusEnum.SUCCESS
    else:
        job.status = JobStatusEnum.FAILED
        job.error_summary = job.error_summary or (
            f"AWX status: {awx_status}; {failed_servers} of {job.total_servers} target(s) "
            "failed or did not complete the required stage"
        )

