"""Granular Customer-Group & OS-Family RBAC scoping helpers."""

from __future__ import annotations

from typing import Iterable, Optional

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.models import (
    JobServer,
    OSFamilyEnum,
    RoleEnum,
    Schedule,
    Server,
    UpdateJob,
    User,
)


def normalize_group_scope(group_ids: Optional[Iterable[int]]) -> Optional[list[int]]:
    if not group_ids:
        return None
    cleaned = sorted({int(gid) for gid in group_ids if isinstance(gid, int) and gid > 0})
    return cleaned or None


def normalize_os_scope(os_families: Optional[Iterable[str]]) -> Optional[list[str]]:
    if not os_families:
        return None
    valid = {OSFamilyEnum.LINUX.value, OSFamilyEnum.WINDOWS.value}
    cleaned = sorted({str(val).strip().lower() for val in os_families if str(val).strip().lower() in valid})
    # Selecting both Linux and Windows is equivalent to unrestricted OS scope
    if not cleaned or len(cleaned) == len(valid):
        return None
    return cleaned


def is_unrestricted_user(user: User) -> bool:
    if user.role == RoleEnum.ADMIN:
        return True
    return not bool(user.allowed_group_ids) and not bool(user.allowed_os_families)


def has_group_restriction(user: User) -> bool:
    return user.role != RoleEnum.ADMIN and bool(user.allowed_group_ids)


def has_os_restriction(user: User) -> bool:
    return user.role != RoleEnum.ADMIN and bool(user.allowed_os_families)


def can_access_server_attributes(
    user: User,
    group_id: Optional[int],
    os_family: OSFamilyEnum | str,
) -> bool:
    if user.role == RoleEnum.ADMIN:
        return True
    if user.allowed_group_ids:
        if group_id is None or int(group_id) not in {int(g) for g in user.allowed_group_ids}:
            return False
    if user.allowed_os_families:
        os_val = os_family.value if isinstance(os_family, OSFamilyEnum) else str(os_family).lower()
        if os_val not in {str(o).lower() for o in user.allowed_os_families}:
            return False
    return True


def can_access_server(user: User, server: Server) -> bool:
    return can_access_server_attributes(user, server.group_id, server.os_family)


def assert_server_attributes_in_scope(
    user: User,
    group_id: Optional[int],
    os_family: OSFamilyEnum | str,
) -> None:
    if not can_access_server_attributes(user, group_id, os_family):
        raise HTTPException(
            status_code=403,
            detail="Access denied: target customer organization or OS family is outside your assigned RBAC scope",
        )


def assert_server_access(user: User, server: Server) -> None:
    if not can_access_server(user, server):
        raise HTTPException(
            status_code=403,
            detail=f"Access denied: endpoint '{server.hostname}' is outside your assigned customer/OS scope",
        )


def assert_servers_access(user: User, servers: Iterable[Server]) -> None:
    if is_unrestricted_user(user):
        return
    denied = [s.hostname for s in servers if not can_access_server(user, s)]
    if denied:
        raise HTTPException(
            status_code=403,
            detail="Access denied for endpoint(s) outside your assigned RBAC scope: " + ", ".join(denied),
        )


def filter_servers_query(query, user: User):
    if is_unrestricted_user(user):
        return query
    if user.allowed_group_ids:
        query = query.filter(Server.group_id.in_([int(g) for g in user.allowed_group_ids]))
    if user.allowed_os_families:
        enums = [OSFamilyEnum(str(o).lower()) for o in user.allowed_os_families]
        query = query.filter(Server.os_family.in_(enums))
    return query


def accessible_server_ids_subquery(db: Session, user: User):
    q = filter_servers_query(db.query(Server.id), user).subquery()
    return select(q.c.id)


def filter_jobs_query(db: Session, query, user: User):
    if is_unrestricted_user(user):
        return query
    srv_sel = accessible_server_ids_subquery(db, user)
    job_ids_sub = db.query(JobServer.job_id).filter(JobServer.server_id.in_(srv_sel)).subquery()
    return query.filter(UpdateJob.id.in_(select(job_ids_sub.c.job_id)))


def assert_job_access(db: Session, user: User, job: UpdateJob, *, require_all_targets: bool = False) -> None:
    if is_unrestricted_user(user):
        return
    server_ids = [rec.server_id for rec in job.server_records if rec.server_id is not None]
    if not server_ids:
        if job.initiated_by == user.username:
            return
        raise HTTPException(status_code=403, detail="Access denied: run is outside your assigned RBAC scope")

    servers = db.query(Server).filter(Server.id.in_(server_ids)).all()
    if require_all_targets:
        assert_servers_access(user, servers)
    else:
        if not any(can_access_server(user, s) for s in servers):
            raise HTTPException(
                status_code=403,
                detail="Access denied: run targets are outside your assigned RBAC scope",
            )


def can_access_schedule(db: Session, user: User, schedule: Schedule) -> bool:
    if is_unrestricted_user(user):
        return True
    if schedule.target_group_id is not None:
        if has_group_restriction(user) and schedule.target_group_id not in {int(g) for g in (user.allowed_group_ids or [])}:
            return False
        if has_os_restriction(user):
            group_servers = db.query(Server).filter(
                Server.group_id == schedule.target_group_id,
                Server.is_managed.is_(True),
            ).all()
            if not group_servers or any(not can_access_server(user, s) for s in group_servers):
                return False
        return True

    target_ids = schedule.target_servers or []
    if not target_ids:
        return schedule.created_by == user.username
    servers = db.query(Server).filter(Server.id.in_(target_ids)).all()
    return bool(servers) and all(can_access_server(user, s) for s in servers)


def assert_schedule_targets_in_scope(
    db: Session,
    user: User,
    target_servers: list[int],
    target_group_id: Optional[int],
) -> None:
    if is_unrestricted_user(user):
        return
    if target_group_id is not None:
        if has_group_restriction(user) and int(target_group_id) not in {int(g) for g in (user.allowed_group_ids or [])}:
            raise HTTPException(
                status_code=403,
                detail="Access denied: selected customer group is outside your assigned RBAC scope",
            )
        if has_os_restriction(user):
            raise HTTPException(
                status_code=403,
                detail="OS-scoped operators must select specific allowed endpoints instead of an entire multi-OS group",
            )
        return

    if target_servers:
        servers = db.query(Server).filter(Server.id.in_(target_servers)).all()
        assert_servers_access(user, servers)
