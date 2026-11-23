import re
import uuid
import csv
import io
from datetime import timedelta
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy import or_
from sqlalchemy.orm import Session, joinedload

from app.config import settings
from app.database import get_db
from app.models.models import (
    AuditLog,
    InstalledPatch,
    JobEvent,
    JobServer,
    JobStatusEnum,
    OSFamilyEnum,
    RoleEnum,
    Schedule,
    Server,
    StageStatusEnum,
    UpdateJob,
    UpdateTypeEnum,
    User,
)
from app.schemas.schemas import (
    InstalledPatchResponse,
    JobCreate,
    JobDetailResponse,
    JobEventResponse,
    JobResponse,
)
from app.services.auth_service import get_current_user, require_admin, require_operator_or_admin
from app.services.awx_client import AWXClientError, awx_client
from app.services.job_executor import create_job_record, utcnow
from app.services.rbac_service import (
    assert_job_access,
    assert_servers_access,
    filter_jobs_query,
)

router = APIRouter(prefix="/jobs", tags=["Jobs & Pipelines"])


def _validate_patch_targets(servers: list[Server], update_type: UpdateTypeEnum) -> None:
    if update_type == UpdateTypeEnum.DISCOVERY:
        return
    # Auto-chain: The patch playbooks (patch_regular.yml & patch_security.yml)
    # execute the discovery role as their initial stage. Un-discovered or stale
    # hosts are auto-discovered during the job without raising HTTP 409.
    for server in servers:
        if server.connection_status.value == "offline":
            raise HTTPException(status_code=409, detail=f"{server.hostname} is offline")
        if server.os_family.value == "linux" and server.package_manager and server.package_manager not in {"apt", "dnf", "yum", "zypper"}:
            raise HTTPException(status_code=422, detail=f"Unsupported Linux package manager on {server.hostname}")
        if server.os_family.value == "windows" and server.package_manager and server.package_manager not in {"windows_update", "win_updates"}:
            raise HTTPException(status_code=422, detail=f"Unsupported Windows update provider on {server.hostname}")


@router.get("", response_model=List[JobResponse])
def get_jobs(
    status: Optional[JobStatusEnum] = None,
    update_type: Optional[UpdateTypeEnum] = None,
    search: Optional[str] = Query(None, max_length=100),
    offset: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    query = filter_jobs_query(db, db.query(UpdateJob), current_user)
    if status:
        query = query.filter(UpdateJob.status == status)
    if update_type:
        query = query.filter(UpdateJob.update_type == update_type)
    if search and search.strip():
        term = f"%{search.strip()}%"
        query = query.filter(or_(
            UpdateJob.build_id.ilike(term),
            UpdateJob.job_name.ilike(term),
            UpdateJob.initiated_by.ilike(term),
        ))
    return query.order_by(UpdateJob.created_at.desc(), UpdateJob.id.desc()).offset(offset).limit(limit).all()


@router.post("", response_model=JobDetailResponse, status_code=202)
def launch_update_job(
    job_in: JobCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_operator_or_admin),
):
    if len(set(job_in.server_ids)) != len(job_in.server_ids):
        raise HTTPException(status_code=422, detail="Duplicate server IDs are not allowed")
    if job_in.update_type == UpdateTypeEnum.MAJOR_UPGRADE:
        if current_user.role.value != "administrator":
            raise HTTPException(status_code=403, detail="Major OS upgrades require administrator approval")
        if not job_in.confirm_major_upgrade or not job_in.backup_verified:
            raise HTTPException(status_code=400, detail="Major OS upgrades require explicit approval and backup confirmation")
    if job_in.allow_overlap and current_user.role.value != "administrator":
        raise HTTPException(status_code=403, detail="Only administrators may approve overlapping jobs")

    # Lock target rows first so concurrent API requests cannot both pass the overlap check.
    servers = db.query(Server).filter(
        Server.id.in_(job_in.server_ids), Server.is_managed.is_(True)
    ).order_by(Server.id).with_for_update().all()
    if len(servers) != len(job_in.server_ids):
        raise HTTPException(status_code=404, detail="One or more selected servers were not found")
    assert_servers_access(current_user, servers)
    missing_credential = [server.hostname for server in servers if server.awx_credential_id is None]
    if missing_credential:
        raise HTTPException(
            status_code=422,
            detail="Select an AWX Machine credential for: " + ", ".join(missing_credential),
        )

    if job_in.update_type == UpdateTypeEnum.MAJOR_UPGRADE:
        non_linux = [s.hostname for s in servers if s.os_family != OSFamilyEnum.LINUX]
        if non_linux:
            raise HTTPException(
                status_code=422,
                detail="Major OS upgrades are supported on Linux endpoints only: " + ", ".join(non_linux),
            )

    if job_in.update_type != UpdateTypeEnum.DISCOVERY:
        _validate_patch_targets(servers, job_in.update_type)

    active = db.query(JobServer).join(UpdateJob).filter(
        JobServer.server_id.in_(job_in.server_ids),
        UpdateJob.status.in_([JobStatusEnum.PENDING, JobStatusEnum.RUNNING]),
    ).all()
    if active and not job_in.allow_overlap:
        names = ", ".join(sorted({record.server_hostname for record in active}))
        raise HTTPException(status_code=409, detail=f"An active job already targets: {names}")

    # Partition targets into homogeneous batches by (os_family, awx_credential_id)
    batches: dict[tuple, list[Server]] = {}
    for server in servers:
        batches.setdefault((server.os_family, server.awx_credential_id), []).append(server)

    created_jobs: list[UpdateJob] = []
    batch_id = f"BATCH-{uuid.uuid4().hex[:12].upper()}" if len(batches) > 1 else None

    if len(batches) == 1:
        job = create_job_record(
            db,
            job_name=job_in.job_name.strip(),
            update_type=job_in.update_type,
            servers=servers,
            initiated_by=current_user.username,
            major_upgrade_approved=bool(job_in.confirm_major_upgrade) if job_in.update_type == UpdateTypeEnum.MAJOR_UPGRADE else False,
            backup_verified=bool(job_in.backup_verified) if job_in.update_type == UpdateTypeEnum.MAJOR_UPGRADE else False,
            overlap_approved=job_in.allow_overlap,
            reboot_only=bool(job_in.reboot_only),
            clean_cache_only=bool(job_in.clean_cache_only),
        )
        job.batch_id = None
        created_jobs.append(job)
    else:
        # Resolve credential names to provide clear, operator-friendly job titles
        cred_name_map = {}
        try:
            creds = awx_client.list_machine_credentials()
            cred_name_map = {c["id"]: c["name"] for c in creds if isinstance(c.get("id"), int)}
        except Exception:
            pass

        base_name = job_in.job_name.strip()
        if "(" in base_name and base_name.endswith(" hosts)"):
            base_name = base_name.rsplit("(", 1)[0].strip()

        sorted_batches = sorted(batches.items(), key=lambda item: (item[0][0].value, item[0][1]))
        for (os_family, cred_id), batch_servers in sorted_batches:
            cred_label = cred_name_map.get(cred_id, f"Credential #{cred_id}")
            batch_job_name = f"{base_name} • {cred_label} ({len(batch_servers)} hosts)"
            job = create_job_record(
                db,
                job_name=batch_job_name,
                update_type=job_in.update_type,
                servers=batch_servers,
                initiated_by=current_user.username,
                major_upgrade_approved=bool(job_in.confirm_major_upgrade) if job_in.update_type == UpdateTypeEnum.MAJOR_UPGRADE else False,
                backup_verified=bool(job_in.backup_verified) if job_in.update_type == UpdateTypeEnum.MAJOR_UPGRADE else False,
                overlap_approved=job_in.allow_overlap,
            )
            job.batch_id = batch_id
            created_jobs.append(job)

    db.commit()
    for j in created_jobs:
        db.refresh(j)

    primary_job = created_jobs[0]
    all_build_ids = [j.build_id for j in created_jobs]
    primary_job.batch_build_ids = all_build_ids
    primary_job.batch_count = len(created_jobs)
    return primary_job


def hydrate_job_detail(db: Session, job: UpdateJob) -> UpdateJob:
    """Attach batch sister jobs and unified server records onto a job instance."""
    sister_jobs: list[UpdateJob] = []
    if getattr(job, "batch_id", None):
        sister_jobs = db.query(UpdateJob).filter(UpdateJob.batch_id == job.batch_id).order_by(UpdateJob.id.asc()).all()
    elif " • " in job.job_name and "(" in job.job_name:
        base_prefix = job.job_name.split(" • ")[0].strip()
        time_window_start = job.created_at - timedelta(minutes=2)
        time_window_end = job.created_at + timedelta(minutes=2)
        sister_jobs = db.query(UpdateJob).filter(
            UpdateJob.initiated_by == job.initiated_by,
            UpdateJob.job_name.like(f"{base_prefix} • %"),
            UpdateJob.created_at >= time_window_start,
            UpdateJob.created_at <= time_window_end,
        ).order_by(UpdateJob.id.asc()).all()

    if len(sister_jobs) > 1:
        job.batch_sister_jobs = sister_jobs
        job.batch_build_ids = [j.build_id for j in sister_jobs]
        job.batch_count = len(sister_jobs)
        job.batch_total_servers = sum(j.total_servers for j in sister_jobs)
        job.batch_successful_servers = sum(j.successful_servers for j in sister_jobs)
        job.batch_failed_servers = sum(j.failed_servers for j in sister_jobs)
        active_count = db.query(JobServer).filter(
            JobServer.job_id.in_([j.id for j in sister_jobs]),
            JobServer.status.in_([JobStatusEnum.PENDING, JobStatusEnum.RUNNING]),
        ).count()
        job.batch_active_servers = active_count
        all_batch_servers = (
            db.query(JobServer)
            .options(joinedload(JobServer.stages))
            .filter(JobServer.job_id.in_([j.id for j in sister_jobs]))
            .order_by(JobServer.server_hostname.asc())
            .all()
        )
        job.batch_server_records = all_batch_servers
    else:
        job.batch_sister_jobs = []
        job.batch_build_ids = [job.build_id]
        job.batch_count = 1
        job.batch_active_servers = None
        job.batch_total_servers = None
        job.batch_successful_servers = None
        job.batch_failed_servers = None
        job.batch_server_records = None

    return job


@router.get("/{build_id}", response_model=JobDetailResponse)
def get_job_by_build_id(
    build_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    job = db.query(UpdateJob).filter(UpdateJob.build_id == build_id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    assert_job_access(db, current_user, job)
    return hydrate_job_detail(db, job)


@router.get("/{build_id}/events", response_model=List[JobEventResponse])
def get_job_events(
    build_id: str,
    offset: int = Query(0, ge=0),
    limit: int = Query(200, ge=1, le=1000),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    job = db.query(UpdateJob).filter(UpdateJob.build_id == build_id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    assert_job_access(db, current_user, job)
    return db.query(JobEvent).filter(JobEvent.job_id == job.id).order_by(JobEvent.awx_event_id).offset(offset).limit(limit).all()


@router.post("/{build_id}/cancel", status_code=202)
def cancel_job(
    build_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_operator_or_admin),
):
    job = db.query(UpdateJob).filter(UpdateJob.build_id == build_id).with_for_update().first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    assert_job_access(db, current_user, job, require_all_targets=True)
    if job.status not in (JobStatusEnum.PENDING, JobStatusEnum.RUNNING):
        raise HTTPException(status_code=409, detail="Only pending or running jobs can be cancelled")

    if job.awx_job_id is None and job.status == JobStatusEnum.PENDING:
        job.status = JobStatusEnum.CANCELLED
        job.end_time = utcnow()
        for record in job.server_records:
            record.status = JobStatusEnum.CANCELLED
            for stage in record.stages:
                if stage.status == StageStatusEnum.PENDING:
                    stage.status = StageStatusEnum.SKIPPED
        message = "Queued job cancelled before AWX launch"
    elif job.awx_job_id is None:
        raise HTTPException(status_code=409, detail="AWX launch state is unresolved; inspect AWX before retrying")
    else:
        try:
            awx_client.cancel_job(job.awx_job_id)
        except AWXClientError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc
        message = "Cancellation requested in AWX; final status will update after AWX confirms it"

    db.add(AuditLog(
        username=current_user.username,
        action="CANCEL_JOB",
        target_resource=job.build_id,
        details=message,
    ))
    db.commit()
    return {"message": message, "status": job.status.value}


@router.get("/{build_id}/export")
def export_job_csv(
    build_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    job = db.query(UpdateJob).filter(UpdateJob.build_id == build_id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    assert_job_access(db, current_user, job)

    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow([
        "Run ID", "Job Name", "Update Type", "Initiated By", "Overlap Approved", "Scheduled For",
        "Server Hostname", "IP Address", "Overall Status", *[f"Stage: {name}" for name in (
            "Discovery", "Pre-check", "Update", "Reboot", "Verification"
        )], "Duration (s)", "Error Details",
    ])
    for record in job.server_records:
        stage_map = {stage.stage_name: stage.status.value for stage in record.stages}
        writer.writerow([
            job.build_id,
            job.job_name,
            job.update_type.value,
            job.initiated_by,
            job.overlap_approved,
            job.scheduled_for.isoformat() if job.scheduled_for else "",
            record.server_hostname,
            record.server_ip,
            record.status.value,
            *[stage_map.get(name, "pending") for name in (
                "Discovery", "Pre-check", "Update", "Reboot", "Verification"
            )],
            record.duration_seconds,
            record.error_details or "",
        ])

    clean_slug = re.sub(r"^(RUN-|BUILD-#?)", "", build_id).replace("#", "") or build_id.replace("#", "")
    return Response(
        content=output.getvalue(),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="run-{clean_slug}.csv"'},
    )


@router.get("/{build_id}/patches", response_model=List[InstalledPatchResponse])
def get_job_installed_patches(
    build_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    job = db.query(UpdateJob).filter(UpdateJob.build_id == build_id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    assert_job_access(db, current_user, job)

    if job.batch_id:
        job_ids = [j.id for j in db.query(UpdateJob.id).filter(UpdateJob.batch_id == job.batch_id).all()]
    else:
        job_ids = [job.id]

    rows = (
        db.query(InstalledPatch, UpdateJob.build_id, Server.hostname)
        .outerjoin(UpdateJob, InstalledPatch.job_id == UpdateJob.id)
        .outerjoin(Server, InstalledPatch.server_id == Server.id)
        .filter(InstalledPatch.job_id.in_(job_ids))
        .order_by(InstalledPatch.installed_at.desc(), InstalledPatch.id.desc())
        .limit(500)
        .all()
    )
    return [
        InstalledPatchResponse(
            id=patch.id,
            job_id=patch.job_id,
            build_id=b_id,
            server_id=patch.server_id,
            server_hostname=hostname,
            package_or_kb=patch.package_or_kb,
            patch_type=patch.patch_type,
            installed_at=patch.installed_at,
        )
        for patch, b_id, hostname in rows
    ]


@router.post("/{build_id}/retry-failed", response_model=JobDetailResponse, status_code=202)
def retry_failed_job(
    build_id: str,
    all_batch: bool = Query(False),
    allow_overlap: bool = Query(False),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_operator_or_admin),
):
    if allow_overlap and current_user.role != RoleEnum.ADMIN:
        raise HTTPException(status_code=403, detail="Only administrators may approve overlapping jobs")

    source_job = db.query(UpdateJob).filter(UpdateJob.build_id == build_id).first()
    if not source_job:
        raise HTTPException(status_code=404, detail="Job not found")

    jobs_to_scan = [source_job]
    if all_batch and source_job.batch_id:
        jobs_to_scan = db.query(UpdateJob).filter(UpdateJob.batch_id == source_job.batch_id).all()

    failed_server_ids = []
    for j in jobs_to_scan:
        for rec in j.server_records:
            if rec.status in (JobStatusEnum.FAILED, JobStatusEnum.CANCELLED) or any(
                st.status == StageStatusEnum.FAILED for st in rec.stages
            ):
                failed_server_ids.append(rec.server_id)

    failed_server_ids = list(dict.fromkeys(failed_server_ids))

    if not failed_server_ids:
        raise HTTPException(status_code=400, detail="No failed or unreachable hosts found in this job to retry")

    servers = db.query(Server).filter(
        Server.id.in_(failed_server_ids), Server.is_managed.is_(True)
    ).order_by(Server.id).with_for_update().all()

    if not servers:
        raise HTTPException(status_code=404, detail="The failed servers are no longer managed")
    assert_servers_access(current_user, servers)

    missing_credential = [s.hostname for s in servers if s.awx_credential_id is None]
    if missing_credential:
        raise HTTPException(
            status_code=422,
            detail="Select an AWX Machine credential for: " + ", ".join(missing_credential),
        )

    active = db.query(JobServer).join(UpdateJob).filter(
        JobServer.server_id.in_([s.id for s in servers]),
        UpdateJob.status.in_([JobStatusEnum.PENDING, JobStatusEnum.RUNNING]),
    ).all()
    if active and not allow_overlap:
        names = ", ".join(sorted({record.server_hostname for record in active}))
        raise HTTPException(status_code=409, detail=f"An active job already targets: {names}")

    base_name = f"Retry #{source_job.build_id} (Failed Hosts)"
    batches: dict[tuple, list[Server]] = {}
    for server in servers:
        batches.setdefault((server.os_family, server.awx_credential_id), []).append(server)

    created_jobs: list[UpdateJob] = []
    batch_id = f"BATCH-{uuid.uuid4().hex[:12].upper()}" if len(batches) > 1 else None

    if len(batches) == 1:
        job = create_job_record(
            db,
            job_name=base_name,
            update_type=source_job.update_type,
            servers=servers,
            initiated_by=current_user.username,
            major_upgrade_approved=source_job.major_upgrade_approved,
            backup_verified=source_job.backup_verified,
            overlap_approved=allow_overlap,
            reboot_only=source_job.reboot_only,
            clean_cache_only=source_job.clean_cache_only,
            retry_of_build_id=source_job.build_id,
        )
        created_jobs.append(job)
    else:
        cred_name_map = {}
        try:
            creds = awx_client.list_machine_credentials()
            cred_name_map = {c["id"]: c["name"] for c in creds if isinstance(c.get("id"), int)}
        except Exception:
            pass

        sorted_batches = sorted(batches.items(), key=lambda item: (item[0][0].value, item[0][1]))
        for (os_family, cred_id), batch_servers in sorted_batches:
            cred_label = cred_name_map.get(cred_id, f"Credential #{cred_id}")
            batch_job_name = f"{base_name} • {cred_label} ({len(batch_servers)} hosts)"
            job = create_job_record(
                db,
                job_name=batch_job_name,
                update_type=source_job.update_type,
                servers=batch_servers,
                initiated_by=current_user.username,
                major_upgrade_approved=source_job.major_upgrade_approved,
                backup_verified=source_job.backup_verified,
                overlap_approved=allow_overlap,
                reboot_only=source_job.reboot_only,
                clean_cache_only=source_job.clean_cache_only,
                retry_of_build_id=source_job.build_id,
                batch_id=batch_id,
            )
            created_jobs.append(job)

    db.commit()
    for j in created_jobs:
        db.refresh(j)

    primary_job = created_jobs[0]
    all_build_ids = [j.build_id for j in created_jobs]
    primary_job.batch_build_ids = all_build_ids
    primary_job.batch_count = len(created_jobs)
    return primary_job
