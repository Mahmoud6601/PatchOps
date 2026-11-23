from typing import List
from zoneinfo import ZoneInfo

from apscheduler.triggers.cron import CronTrigger
from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.models import AuditLog, Schedule, Server, ServerGroup, UpdateTypeEnum, User
from app.schemas.schemas import ScheduleCreate, ScheduleResponse, ScheduleUpdate
from app.services.auth_service import get_current_user, require_operator_or_admin
from app.services.job_executor import utcnow
from app.services.rbac_service import (
    assert_schedule_targets_in_scope,
    can_access_schedule,
    is_unrestricted_user,
)
from app.services.scheduling import compute_next_run, to_utc_naive

router = APIRouter(prefix="/schedules", tags=["Schedules"])


def _validate_targets(db: Session, target_servers: list[int], target_group_id: int | None) -> None:
    if bool(target_servers) == (target_group_id is not None):
        raise HTTPException(status_code=422, detail="Select either one or more servers or a server group")
    if target_servers:
        if len(set(target_servers)) != len(target_servers):
            raise HTTPException(status_code=422, detail="Duplicate target server IDs are not allowed")
        targets = db.query(Server).filter(
            Server.id.in_(target_servers), Server.is_managed.is_(True)
        ).all()
        if len(targets) != len(target_servers):
            raise HTTPException(status_code=404, detail="One or more target servers were not found")
    else:
        group = db.query(ServerGroup).filter(ServerGroup.id == target_group_id).first()
        if not group:
            raise HTTPException(status_code=404, detail="Target server group was not found")
        targets = db.query(Server).filter(
            Server.group_id == target_group_id,
            Server.is_managed.is_(True),
        ).all()

    # Multi-OS targets are automatically batched into homogeneous jobs by the worker


def _validate_trigger(
    cron_expression: str | None,
    scheduled_time,
    timezone_name: str,
    *,
    scheduled_time_is_utc: bool = False,
) -> None:
    if bool(cron_expression) == (scheduled_time is not None):
        raise HTTPException(status_code=422, detail="Provide either a recurring cron expression or a one-time scheduled time")
    if cron_expression:
        try:
            CronTrigger.from_crontab(cron_expression, timezone=ZoneInfo(timezone_name))
        except (ValueError, KeyError) as exc:
            raise HTTPException(status_code=422, detail=f"Invalid cron expression: {exc}") from exc
    elif scheduled_time is not None:
        try:
            instant = scheduled_time if scheduled_time_is_utc else to_utc_naive(scheduled_time, timezone_name)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        if instant <= utcnow():
            raise HTTPException(status_code=422, detail="One-time schedule must be in the future")


@router.get("", response_model=List[ScheduleResponse])
def get_schedules(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    all_schedules = db.query(Schedule).order_by(Schedule.next_run_at.asc().nullslast(), Schedule.created_at.desc()).all()
    if is_unrestricted_user(current_user):
        return all_schedules
    return [s for s in all_schedules if can_access_schedule(db, current_user, s)]


@router.post("", response_model=ScheduleResponse, status_code=201)
def create_schedule(
    sched_in: ScheduleCreate,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_operator_or_admin),
):
    if sched_in.update_type == UpdateTypeEnum.MAJOR_UPGRADE:
        raise HTTPException(status_code=422, detail="Major OS upgrades must be launched as individually approved jobs")
    _validate_targets(db, sched_in.target_servers, sched_in.target_group_id)
    assert_schedule_targets_in_scope(db, current_user, sched_in.target_servers, sched_in.target_group_id)
    _validate_trigger(sched_in.cron_expression, sched_in.scheduled_time, sched_in.timezone)
    if not sched_in.prevent_overlap and current_user.role.value != "administrator":
        raise HTTPException(status_code=403, detail="Only administrators may allow overlapping schedules")

    scheduled_time = to_utc_naive(sched_in.scheduled_time, sched_in.timezone) if sched_in.scheduled_time else None
    schedule = Schedule(
        name=sched_in.name.strip(),
        update_type=sched_in.update_type,
        target_servers=sched_in.target_servers,
        target_group_id=sched_in.target_group_id,
        cron_expression=sched_in.cron_expression,
        scheduled_time=scheduled_time,
        timezone=sched_in.timezone,
        maintenance_window_mins=sched_in.maintenance_window_mins,
        prevent_overlap=sched_in.prevent_overlap,
        is_active=sched_in.is_active,
        created_by=current_user.username,
    )
    schedule.next_run_at = compute_next_run(schedule) if schedule.is_active else None
    if schedule.is_active and schedule.next_run_at is None:
        raise HTTPException(status_code=422, detail="Schedule has no future execution time")
    db.add(schedule)
    db.flush()
    db.add(AuditLog(
        username=current_user.username,
        action="CREATE_SCHEDULE",
        target_resource=schedule.name,
        details=f"Created {schedule.update_type.value} schedule; next run {schedule.next_run_at or 'disabled'}",
        ip_address=request.client.host if request.client else None,
    ))
    db.commit()
    db.refresh(schedule)
    return schedule


@router.put("/{sched_id}", response_model=ScheduleResponse)
def update_schedule(
    sched_id: int,
    sched_in: ScheduleUpdate,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_operator_or_admin),
):
    schedule = db.query(Schedule).filter(Schedule.id == sched_id).with_for_update().first()
    if not schedule:
        raise HTTPException(status_code=404, detail="Schedule not found")
    if not can_access_schedule(db, current_user, schedule):
        raise HTTPException(status_code=403, detail="Access denied: schedule targets are outside your RBAC scope")
    values = sched_in.model_dump(exclude_unset=True)

    name = values.get("name", schedule.name)
    update_type = values.get("update_type", schedule.update_type)
    target_servers = values.get("target_servers", schedule.target_servers or [])
    target_group_id = values.get("target_group_id", schedule.target_group_id)
    cron_expression = values.get("cron_expression", schedule.cron_expression)
    scheduled_time_was_supplied = "scheduled_time" in values
    scheduled_time_input = values.get("scheduled_time") if scheduled_time_was_supplied else schedule.scheduled_time
    stored_utc_time = not scheduled_time_was_supplied and scheduled_time_input is not None
    timezone_name = values.get("timezone", schedule.timezone)
    is_active = values.get("is_active", schedule.is_active)
    prevent_overlap = values.get("prevent_overlap", schedule.prevent_overlap)

    if update_type == UpdateTypeEnum.MAJOR_UPGRADE:
        raise HTTPException(status_code=422, detail="Major OS upgrades must be launched as individually approved jobs")
    if not prevent_overlap and current_user.role.value != "administrator":
        raise HTTPException(status_code=403, detail="Only administrators may allow overlapping schedules")
    _validate_targets(db, target_servers, target_group_id)
    assert_schedule_targets_in_scope(db, current_user, target_servers, target_group_id)
    _validate_trigger(
        cron_expression,
        scheduled_time_input,
        timezone_name,
        scheduled_time_is_utc=stored_utc_time,
    )

    trigger_changed = any(key in values for key in ("cron_expression", "scheduled_time", "timezone"))
    for key, value in values.items():
        setattr(schedule, key, value)
    schedule.name = name.strip()
    schedule.target_servers = target_servers
    schedule.target_group_id = target_group_id
    schedule.scheduled_time = (
        to_utc_naive(scheduled_time_input, timezone_name)
        if scheduled_time_input is not None and not stored_utc_time
        else scheduled_time_input
    )
    if "timezone" in values:
        schedule.timezone = timezone_name
    if trigger_changed or (is_active and schedule.next_run_at is None):
        schedule.next_run_at = compute_next_run(schedule) if is_active else None
    if not is_active:
        schedule.next_run_at = None
    elif schedule.next_run_at is None:
        raise HTTPException(status_code=422, detail="Schedule has no future execution time")

    db.add(AuditLog(
        username=current_user.username,
        action="UPDATE_SCHEDULE",
        target_resource=schedule.name,
        details=f"Updated schedule {schedule.name}",
        ip_address=request.client.host if request.client else None,
    ))
    db.commit()
    db.refresh(schedule)
    return schedule


@router.post("/{sched_id}/toggle", response_model=ScheduleResponse)
def toggle_schedule(
    sched_id: int,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_operator_or_admin),
):
    schedule = db.query(Schedule).filter(Schedule.id == sched_id).with_for_update().first()
    if not schedule:
        raise HTTPException(status_code=404, detail="Schedule not found")
    if not can_access_schedule(db, current_user, schedule):
        raise HTTPException(status_code=403, detail="Access denied: schedule targets are outside your RBAC scope")
    schedule.is_active = not schedule.is_active
    schedule.next_run_at = compute_next_run(schedule) if schedule.is_active else None
    if schedule.is_active and schedule.next_run_at is None:
        schedule.is_active = False
        raise HTTPException(status_code=409, detail="Schedule has no future run time; edit it before enabling")
    db.add(AuditLog(
        username=current_user.username,
        action="TOGGLE_SCHEDULE",
        target_resource=schedule.name,
        details=f"Schedule enabled={schedule.is_active}",
        ip_address=request.client.host if request.client else None,
    ))
    db.commit()
    db.refresh(schedule)
    return schedule


@router.delete("/{sched_id}")
def delete_schedule(
    sched_id: int,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_operator_or_admin),
):
    schedule = db.query(Schedule).filter(Schedule.id == sched_id).with_for_update().first()
    if not schedule:
        raise HTTPException(status_code=404, detail="Schedule not found")
    if not can_access_schedule(db, current_user, schedule):
        raise HTTPException(status_code=403, detail="Access denied: schedule targets are outside your RBAC scope")
    name = schedule.name
    db.delete(schedule)
    db.add(AuditLog(
        username=current_user.username,
        action="DELETE_SCHEDULE",
        target_resource=name,
        details=f"Deleted schedule {name}",
        ip_address=request.client.host if request.client else None,
    ))
    db.commit()
    return {"message": "Schedule deleted successfully"}
