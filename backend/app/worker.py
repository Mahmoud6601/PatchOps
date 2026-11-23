"""Durable database-backed dispatcher and schedule runner for AWX jobs."""

import logging
import time
import uuid
from datetime import datetime, timedelta

from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.config import settings
from app.database import SessionLocal, engine
from app.models.models import (
    AuditLog,
    JobServer,
    JobStatusEnum,
    Schedule,
    Server,
    StageStatusEnum,
    UpdateJob,
    UpdateTypeEnum,
)
from app.services.awx_client import AWXClientError, awx_client
from app.services.job_executor import create_job_record, finalize_awx_job, process_awx_events, utcnow
from app.services.scheduling import advance_next_run

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("patching_worker")

_WORKER_LOCK_ID = 87421033
_TEMPLATE_SETTING = {
    UpdateTypeEnum.DISCOVERY: "AWX_DISCOVERY_TEMPLATE_NAME",
    UpdateTypeEnum.SECURITY: "AWX_SECURITY_TEMPLATE_NAME",
    UpdateTypeEnum.REGULAR: "AWX_REGULAR_TEMPLATE_NAME",
    UpdateTypeEnum.MAJOR_UPGRADE: "AWX_MAJOR_UPGRADE_TEMPLATE_NAME",
}


def _template_name(job: UpdateJob) -> str:
    target_families = {
        record.server.os_family.value
        for record in job.server_records
        if record.server is not None
    }
    if len(target_families) != 1:
        raise AWXClientError("Run Linux and Windows targets in separate jobs")
    return getattr(settings, _TEMPLATE_SETTING[job.update_type])


def _launch_credential_ids(job: UpdateJob, template: dict) -> list[int]:
    families = {record.server.os_family.value for record in job.server_records if record.server is not None}
    if len(families) != 1:
        raise AWXClientError("Run Linux and Windows targets in separate jobs")
    credential_ids = {record.server.awx_credential_id for record in job.server_records if record.server is not None}
    if None in credential_ids:
        missing = [record.server_hostname for record in job.server_records if record.server and record.server.awx_credential_id is None]
        raise AWXClientError("Select an AWX Machine credential for: " + ", ".join(missing))
    if len(credential_ids) != 1:
        raise AWXClientError("Run servers that use different AWX credentials in separate jobs")
    credential_id = next(iter(credential_ids))
    if credential_id is None:
        raise AWXClientError("Select an AWX Machine credential before launching a job")
    if not template.get("ask_credential_on_launch", False):
        raise AWXClientError(
            f"AWX template '{template.get('name', 'unknown')}' must allow credential selection at launch"
        )
    credential = awx_client.get_credential_by_id(credential_id)
    if credential.get("kind") != "ssh":
        raise AWXClientError(f"AWX credential {credential_id} must be a Machine credential")
    return [credential_id]


def _mark_launch_failed(db: Session, job: UpdateJob, message: str) -> None:
    now = utcnow()
    job.status = JobStatusEnum.FAILED
    job.end_time = now
    if job.start_time:
        job.duration_seconds = max(0, int((now - job.start_time).total_seconds()))
    job.error_summary = message[:2000]
    job.failed_servers = job.total_servers
    for record in job.server_records:
        record.status = JobStatusEnum.FAILED
        record.end_time = now
        record.error_details = message[:2000]
        for stage in record.stages:
            if stage.status in (StageStatusEnum.PENDING, StageStatusEnum.RUNNING):
                stage.status = StageStatusEnum.SKIPPED
                stage.end_time = None
    db.add(AuditLog(
        username="worker",
        action="AWX_LAUNCH_FAILED",
        target_resource=job.build_id,
        details=message[:1000],
    ))
    db.commit()


def _mark_job_started(job: UpdateJob, awx_started_at: datetime | None = None) -> None:
    """Move the platform job into RUNNING only after AWX has actually started it."""
    started_at = awx_started_at or utcnow()
    job.status = JobStatusEnum.RUNNING
    job.start_time = job.start_time or started_at
    for record in job.server_records:
        if record.status == JobStatusEnum.PENDING:
            record.status = JobStatusEnum.RUNNING
            record.start_time = record.start_time or job.start_time


def _awx_started_at(awx_job: dict) -> datetime | None:
    """Convert AWX's ISO timestamp to the naive UTC convention used by the app."""
    value = awx_job.get("started")
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return parsed.replace(tzinfo=None)
    except ValueError:
        return None


def dispatch_one_pending_job(db: Session) -> bool:
    # A pending job with an AWX ID has already been accepted by AWX and is
    # waiting in its queue; never launch it a second time.
    job = db.query(UpdateJob).filter(
        UpdateJob.status == JobStatusEnum.PENDING,
        UpdateJob.awx_job_id.is_(None),
    ).order_by(
        UpdateJob.created_at.asc(), UpdateJob.id.asc()
    ).with_for_update(skip_locked=True).first()
    if not job:
        return False

    retired_targets = [record.server_hostname for record in job.server_records if not record.server or not record.server.is_managed]
    if not job.server_records or retired_targets:
        now = utcnow()
        message = (
            "AWX launch was stopped because the job has no persisted server targets."
            if not job.server_records else
            "Job was stopped because a target was retired before AWX launch: " + ", ".join(retired_targets)
        )
        job.status = JobStatusEnum.FAILED
        job.end_time = now
        job.failed_servers = job.total_servers
        job.error_summary = message[:2000]
        for record in job.server_records:
            record.status = JobStatusEnum.FAILED
            record.end_time = now
            record.error_details = message[:2000]
            for stage in record.stages:
                if stage.status == StageStatusEnum.PENDING:
                    stage.status = StageStatusEnum.SKIPPED
        db.add(AuditLog(
            username="worker",
            action="JOB_ABORTED_INVALID_TARGET",
            target_resource=job.build_id,
            details=message[:1000],
        ))
        db.commit()
        return True

    try:
        template = awx_client.get_job_template_by_name(_template_name(job))
        if template is None:
            template_name = _template_name(job)
            raise AWXClientError(f"AWX job template '{template_name}' was not found")
        if settings.AWX_INVENTORY_ID is None:
            raise AWXClientError("AWX_INVENTORY_ID must be configured before jobs can be dispatched")
        if template.get("inventory") != settings.AWX_INVENTORY_ID:
            raise AWXClientError(
                f"AWX job template '{_template_name(job)}' must use configured inventory {settings.AWX_INVENTORY_ID}"
            )
        template_id = int(template["id"])
        awx_client.sync_inventory_hosts(
            settings.AWX_INVENTORY_ID,
            [record.server for record in job.server_records if record.server is not None],
        )
        credential_ids = _launch_credential_ids(job, template)
    except Exception as exc:
        logger.exception("AWX dispatch preflight failed for build_id=%s", job.build_id)
        _mark_launch_failed(db, job, str(exc))
        return True

    try:
        limit = ":".join(record.server_hostname for record in job.server_records)
        extra_vars = {
            "update_type": job.update_type.value,
            "force_reboot": False,
            "reboot_only": bool(getattr(job, "reboot_only", False)),
            "clean_cache_only": bool(getattr(job, "clean_cache_only", False)),
            "confirm_major_upgrade": bool(job.major_upgrade_approved),
            "backup_verified": bool(job.backup_verified),
        }
        launched = awx_client.launch_job_template(
            template_id,
            extra_vars=extra_vars,
            limit=limit,
            credential_ids=credential_ids,
        )
    except AWXClientError as exc:
        # An HTTP 4xx response means AWX rejected the request before creating
        # a job. It is safe to fail it immediately; it must not appear as a
        # running build with an unknown launch state.
        if exc.status_code is not None and 400 <= exc.status_code < 500:
            logger.error("AWX rejected launch for build_id=%s: %s", job.build_id, exc)
            _mark_launch_failed(db, job, str(exc))
            return True
        # Timeouts and server-side failures can happen after AWX accepted the
        # POST, so retain the durable unresolved state and never relaunch it.
        _mark_job_started(job)
        job.error_summary = (
            "AWX launch outcome is unknown. Inspect AWX before retrying this build. "
            f"Details: {str(exc)[:1500]}"
        )
        db.commit()
        logger.exception("AWX launch outcome is unknown for build_id=%s", job.build_id)
        return True
    except Exception as exc:
        # A timeout or broken response can happen after AWX accepted the POST.
        # Keep the server lock and never retry automatically until an operator
        # has checked AWX for the corresponding run.
        _mark_job_started(job)
        job.error_summary = (
            "AWX launch outcome is unknown. Inspect AWX before retrying this build. "
            f"Details: {str(exc)[:1500]}"
        )
        db.commit()
        logger.exception("AWX launch outcome is unknown for build_id=%s", job.build_id)
        return True

    try:
        job.awx_job_id = int(launched["job"])
        db.commit()
        logger.info("Launched AWX job build_id=%s awx_job_id=%s", job.build_id, job.awx_job_id)
    except Exception:
        # If saving the AWX ID fails, leave the job unresolved so recovery
        # cannot launch it twice.
        db.rollback()
        logger.exception("AWX job ID could not be persisted for build_id=%s", job.build_id)
    return True


def poll_active_jobs(db: Session) -> None:
    active_jobs = db.query(UpdateJob).filter(
        UpdateJob.status.in_([JobStatusEnum.PENDING, JobStatusEnum.RUNNING]),
        UpdateJob.awx_job_id.isnot(None),
    ).order_by(UpdateJob.id.asc()).all()
    for job in active_jobs:
        try:
            awx_job = awx_client.get_job_status(job.awx_job_id)
            status = str(awx_job.get("status", "unknown")).lower()
            if status == "running":
                _mark_job_started(job, _awx_started_at(awx_job))
            event_error = None
            try:
                events = awx_client.get_job_events(job.awx_job_id)
            except Exception as exc:
                if status not in {"successful", "failed", "canceled", "error"}:
                    raise
                events = []
                event_error = f"AWX task events could not be retrieved ({type(exc).__name__})"
            process_awx_events(db, job, events)
            if status in {"successful", "failed", "canceled", "error"}:
                # It is possible for a very short AWX job to finish between
                # polling cycles. Preserve a truthful, non-negative duration.
                if job.start_time is None:
                    _mark_job_started(job, _awx_started_at(awx_job))
                summary_error = None
                try:
                    summaries = awx_client.get_job_host_summaries(job.awx_job_id)
                except Exception as exc:
                    summaries = []
                    summary_error = f"AWX host summaries could not be retrieved ({type(exc).__name__})"
                try:
                    stdout = awx_client.get_job_stdout(job.awx_job_id)
                except Exception as exc:
                    stdout = f"AWX stdout unavailable ({type(exc).__name__})"
                finalize_awx_job(db, job, status, summaries, stdout)
                if event_error or summary_error:
                    job.status = JobStatusEnum.CANCELLED if status == "canceled" else JobStatusEnum.FAILED
                    job.error_summary = "; ".join(error for error in (event_error, summary_error) if error)
                db.add(AuditLog(
                    username="worker",
                    action="AWX_JOB_FINISHED",
                    target_resource=job.build_id,
                    details=f"AWX job {job.awx_job_id} finished with status {status}",
                ))
                logger.info("Finished AWX job build_id=%s status=%s", job.build_id, job.status.value)
            db.commit()
        except Exception as exc:
            db.rollback()
            logger.warning("AWX poll failed for build_id=%s error=%s", job.build_id, type(exc).__name__)

    # A worker crash before storing AWX's job ID is ambiguous. Never relaunch it automatically.
    cutoff = utcnow() - timedelta(minutes=5)
    ambiguous = db.query(UpdateJob).filter(
        UpdateJob.status == JobStatusEnum.RUNNING,
        UpdateJob.awx_job_id.is_(None),
    ).all()
    for job in ambiguous:
        if job.start_time and job.start_time < cutoff:
            _mark_launch_failed(
                db,
                job,
                "The worker stopped before it stored the AWX job ID. Inspect AWX before retrying this build.",
            )


def _schedule_target_servers(db: Session, schedule: Schedule) -> list[Server]:
    if schedule.target_group_id is not None:
        return db.query(Server).filter(
            Server.group_id == schedule.target_group_id,
            Server.is_managed.is_(True),
        ).order_by(Server.id).all()
    server_ids = schedule.target_servers or []
    return db.query(Server).filter(
        Server.id.in_(server_ids), Server.is_managed.is_(True)
    ).order_by(Server.id).all() if server_ids else []


def process_due_schedules(db: Session, now: datetime | None = None) -> None:
    now = now or utcnow()
    due = db.query(Schedule).filter(
        Schedule.is_active.is_(True),
        Schedule.next_run_at.isnot(None),
        Schedule.next_run_at <= now,
    ).order_by(Schedule.next_run_at.asc(), Schedule.id.asc()).with_for_update(skip_locked=True).limit(50).all()

    for schedule in due:
        scheduled_for = schedule.next_run_at
        servers = _schedule_target_servers(db, schedule)
        server_ids = [server.id for server in servers]

        active_overlap = []
        if server_ids and schedule.prevent_overlap:
            active_overlap = db.query(JobServer.server_id).join(UpdateJob).filter(
                JobServer.server_id.in_(server_ids),
                UpdateJob.status.in_([JobStatusEnum.PENDING, JobStatusEnum.RUNNING]),
            ).distinct().all()

        missed_window = bool(
            scheduled_for and now > scheduled_for + timedelta(minutes=schedule.maintenance_window_mins)
        )
        missing_cred_hosts = [s.hostname for s in servers if s.awx_credential_id is None]
        valid_servers = [s for s in servers if s.awx_credential_id is not None]

        if not servers or not valid_servers or active_overlap or missed_window:
            reason = (
                "no target servers found" if not servers else
                "scheduled launch window elapsed" if missed_window else
                "overlap prevention skipped this occurrence" if active_overlap else
                "missing AWX Machine credential for: " + ", ".join(missing_cred_hosts)
            )
            db.add(AuditLog(
                username="worker",
                action="SCHEDULE_SKIPPED",
                target_resource=schedule.name,
                details=reason[:1000],
            ))
        else:
            if missing_cred_hosts:
                db.add(AuditLog(
                    username="worker",
                    action="SCHEDULE_PARTIAL_SKIP",
                    target_resource=schedule.name,
                    details=("Skipped targets missing AWX Machine credential: " + ", ".join(missing_cred_hosts))[:1000],
                ))

            batches: dict[tuple, list[Server]] = {}
            for server in valid_servers:
                batches.setdefault((server.os_family, server.awx_credential_id), []).append(server)

            batch_id = f"BATCH-{uuid.uuid4().hex[:12].upper()}" if len(batches) > 1 else None

            if len(batches) == 1:
                create_job_record(
                    db,
                    job_name=schedule.name,
                    update_type=schedule.update_type,
                    servers=valid_servers,
                    initiated_by=schedule.created_by,
                    overlap_approved=not schedule.prevent_overlap,
                    scheduled_for=scheduled_for,
                )
            else:
                sorted_batches = sorted(batches.items(), key=lambda item: (item[0][0].value, item[0][1]))
                for (os_family, cred_id), batch_servers in sorted_batches:
                    batch_title = f"{schedule.name} • {os_family.value.title()} ({len(batch_servers)} hosts)"
                    create_job_record(
                        db,
                        job_name=batch_title,
                        update_type=schedule.update_type,
                        servers=batch_servers,
                        initiated_by=schedule.created_by,
                        overlap_approved=not schedule.prevent_overlap,
                        scheduled_for=scheduled_for,
                        batch_id=batch_id,
                    )

        schedule.last_run_at = now
        if schedule.cron_expression:
            schedule.next_run_at = advance_next_run(schedule, now)
            if schedule.next_run_at is None:
                schedule.is_active = False
        else:
            schedule.next_run_at = None
            schedule.is_active = False
        db.commit()


def run_forever() -> None:
    if engine.dialect.name != "postgresql":
        raise RuntimeError("The persistent worker requires PostgreSQL advisory locks")

    lock_connection = engine.connect()
    acquired = lock_connection.execute(
        text("SELECT pg_try_advisory_lock(:lock_id)"), {"lock_id": _WORKER_LOCK_ID}
    ).scalar()
    if not acquired:
        lock_connection.close()
        raise RuntimeError("Another patching worker already holds the scheduler lock")

    logger.info("Patching worker started")
    try:
        while True:
            try:
                with SessionLocal() as db:
                    process_due_schedules(db)
                    poll_active_jobs(db)
                    for _ in range(10):
                        if not dispatch_one_pending_job(db):
                            break
            except SQLAlchemyError as exc:
                logger.exception("Worker database cycle failed: %s", type(exc).__name__)
            except Exception:
                logger.exception("Worker cycle failed")
            time.sleep(max(1, settings.WORKER_POLL_INTERVAL_SECONDS))
    finally:
        try:
            lock_connection.execute(text("SELECT pg_advisory_unlock(:lock_id)"), {"lock_id": _WORKER_LOCK_ID})
        finally:
            lock_connection.close()


if __name__ == "__main__":
    run_forever()
