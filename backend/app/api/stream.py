"""Server-Sent Events (SSE) real-time push endpoints for live pipeline runs and fleet telemetry."""

from __future__ import annotations

import asyncio
import hashlib
import json
from typing import AsyncGenerator

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.api.jobs import hydrate_job_detail
from app.database import SessionLocal, get_db
from app.models.models import (
    ConnectionStatusEnum,
    InstalledPatch,
    JobEvent,
    JobStatusEnum,
    Server,
    UpdateJob,
    User,
)
from app.schemas.schemas import InstalledPatchResponse, JobDetailResponse
from app.services.auth_service import get_current_user
from app.services.rbac_service import (
    assert_job_access,
    filter_jobs_query,
    filter_servers_query,
)

router = APIRouter(prefix="/stream", tags=["Real-Time SSE"])

SSE_HEADERS = {
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
}

TERMINAL_STATUSES = {
    JobStatusEnum.SUCCESS,
    JobStatusEnum.FAILED,
    JobStatusEnum.CANCELLED,
}


def compute_fleet_watermark(db: Session, user: User) -> str:
    srv_q = filter_servers_query(db.query(Server).filter(Server.is_managed.is_(True)), user)
    srv_total = srv_q.count()
    srv_online = srv_q.filter(Server.connection_status == ConnectionStatusEnum.ONLINE).count()
    sums = filter_servers_query(
        db.query(
            func.coalesce(func.sum(Server.pending_updates_count), 0),
            func.coalesce(func.sum(Server.security_updates_count), 0),
        ).filter(Server.is_managed.is_(True)),
        user,
    ).one()
    reboot_cnt = srv_q.filter(Server.reboot_required.is_(True)).count()

    job_q = filter_jobs_query(db, db.query(UpdateJob), user)
    latest_job_id = job_q.with_entities(func.coalesce(func.max(UpdateJob.id), 0)).scalar() or 0
    active_rows = (
        job_q.filter(UpdateJob.status.in_([JobStatusEnum.PENDING, JobStatusEnum.RUNNING]))
        .with_entities(UpdateJob.id, UpdateJob.status, UpdateJob.awx_job_id)
        .order_by(UpdateJob.id.asc())
        .all()
    )
    active_sig = ",".join(f"{r[0]}:{r[1].value}:{r[2]}" for r in active_rows)
    latest_event_id = db.query(func.coalesce(func.max(JobEvent.id), 0)).scalar() or 0

    raw = f"{srv_total}|{srv_online}|{sums[0]}|{sums[1]}|{reboot_cnt}|{latest_job_id}|{active_sig}|{latest_event_id}"
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:16]


def build_job_snapshot_payload(db: Session, build_id: str) -> tuple[dict, str, bool] | None:
    job = db.query(UpdateJob).filter(UpdateJob.build_id == build_id).first()
    if not job:
        return None
    hydrate_job_detail(db, job)

    if job.batch_id:
        job_ids = [j.id for j in db.query(UpdateJob.id).filter(UpdateJob.batch_id == job.batch_id).all()]
    else:
        job_ids = [job.id]

    patch_rows = (
        db.query(InstalledPatch, UpdateJob.build_id, Server.hostname)
        .outerjoin(UpdateJob, InstalledPatch.job_id == UpdateJob.id)
        .outerjoin(Server, InstalledPatch.server_id == Server.id)
        .filter(InstalledPatch.job_id.in_(job_ids))
        .order_by(InstalledPatch.installed_at.desc(), InstalledPatch.id.desc())
        .limit(500)
        .all()
    )
    patches_data = [
        InstalledPatchResponse(
            id=p.id,
            job_id=p.job_id,
            build_id=b_id,
            server_id=p.server_id,
            server_hostname=h_name,
            package_or_kb=p.package_or_kb,
            patch_type=p.patch_type,
            installed_at=p.installed_at,
        ).model_dump(mode="json")
        for p, b_id, h_name in patch_rows
    ]

    job_dict = JobDetailResponse.model_validate(job).model_dump(mode="json")
    payload = {"job": job_dict, "patches": patches_data}
    serialized = json.dumps(payload, separators=(",", ":"))
    digest = hashlib.sha1(serialized.encode("utf-8")).hexdigest()

    sister_jobs = getattr(job, "batch_sister_jobs", None) or []
    if sister_jobs:
        is_terminal = all(sj.status in TERMINAL_STATUSES for sj in sister_jobs)
    else:
        is_terminal = job.status in TERMINAL_STATUSES

    return payload, digest, is_terminal


@router.get("/jobs/{build_id}")
async def stream_job_updates(
    build_id: str,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    job = db.query(UpdateJob).filter(UpdateJob.build_id == build_id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    assert_job_access(db, current_user, job)
    user_id = current_user.id

    async def event_generator() -> AsyncGenerator[str, None]:
        last_digest = ""
        idle_ticks = 0
        while True:
            if await request.is_disconnected():
                break

            with SessionLocal() as sdb:
                user = sdb.query(User).filter(User.id == user_id, User.is_active.is_(True)).first()
                if not user:
                    break
                snapshot = build_job_snapshot_payload(sdb, build_id)

            if snapshot is None:
                break

            payload, digest, is_terminal = snapshot
            if digest != last_digest:
                last_digest = digest
                idle_ticks = 0
                yield f"event: job_update\ndata: {json.dumps(payload)}\n\n"
            else:
                idle_ticks += 1
                if idle_ticks >= 15:
                    idle_ticks = 0
                    yield ": keepalive\n\n"

            if is_terminal:
                yield f"event: complete\ndata: {json.dumps({'build_id': build_id})}\n\n"
                break

            await asyncio.sleep(1.0)

    return StreamingResponse(event_generator(), media_type="text/event-stream", headers=SSE_HEADERS)


@router.get("/fleet")
async def stream_fleet_updates(
    request: Request,
    current_user: User = Depends(get_current_user),
):
    user_id = current_user.id

    async def event_generator() -> AsyncGenerator[str, None]:
        last_watermark = ""
        idle_ticks = 0
        while True:
            if await request.is_disconnected():
                break

            with SessionLocal() as sdb:
                user = sdb.query(User).filter(User.id == user_id, User.is_active.is_(True)).first()
                if not user:
                    break
                watermark = compute_fleet_watermark(sdb, user)

            if watermark != last_watermark:
                last_watermark = watermark
                idle_ticks = 0
                yield f"event: fleet_update\ndata: {json.dumps({'watermark': watermark})}\n\n"
            else:
                idle_ticks += 1
                if idle_ticks >= 8:
                    idle_ticks = 0
                    yield ": keepalive\n\n"

            await asyncio.sleep(2.0)

    return StreamingResponse(event_generator(), media_type="text/event-stream", headers=SSE_HEADERS)
