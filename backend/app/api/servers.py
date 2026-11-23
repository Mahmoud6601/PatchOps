import uuid
from pydantic import BaseModel
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.models.models import (
    AuditLog,
    ConnectionStatusEnum,
    InstalledPatch,
    JobServer,
    JobStatusEnum,
    OSFamilyEnum,
    RoleEnum,
    Server,
    ServerGroup,
    UpdateJob,
    UpdateTypeEnum,
    User,
)


class BulkServersRequest(BaseModel):
    server_ids: List[int]
    action: Optional[str] = "reboot"
    allow_overlap: bool = False


from app.schemas.schemas import (
    InstalledPatchResponse,
    JobDetailResponse,
    AWXMachineCredentialResponse,
    ServerCreate,
    ServerGroupCreate,
    ServerGroupResponse,
    ServerResponse,
    ServerUpdate,
    ServerGroupUpdate,
)
from app.services.auth_service import get_current_user, require_admin, require_operator_or_admin
from app.services.awx_client import AWXClientError, awx_client
from app.services.rbac_service import (
    assert_server_access,
    assert_server_attributes_in_scope,
    assert_servers_access,
    can_access_server,
    filter_servers_query,
    has_group_restriction,
)
from app.services.job_executor import create_job_record, utcnow

router = APIRouter(prefix="/servers", tags=["Servers"])


def _has_active_job(db: Session, server_id: int) -> bool:
    return db.query(JobServer.id).join(UpdateJob).filter(
        JobServer.server_id == server_id,
        UpdateJob.status.in_([JobStatusEnum.PENDING, JobStatusEnum.RUNNING]),
    ).first() is not None


def _validate_awx_machine_credential(credential_id: int) -> None:
    try:
        credential = awx_client.get_credential_by_id(credential_id)
    except AWXClientError as exc:
        raise HTTPException(status_code=422, detail=f"AWX credential {credential_id} is unavailable to the platform") from exc
    if credential.get("kind") != "ssh":
        raise HTTPException(status_code=422, detail="Select an AWX Machine credential")


@router.get("", response_model=List[ServerResponse])
def get_servers(
    include_retired: bool = False,
    group_id: Optional[int] = None,
    os_family: Optional[OSFamilyEnum] = None,
    reboot_required: Optional[bool] = None,
    search: Optional[str] = None,
    offset: int = Query(0, ge=0),
    limit: int = Query(100, ge=1, le=500),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    if include_retired and current_user.role.value != "administrator":
        raise HTTPException(status_code=403, detail="Only administrators may view retired servers")
    query = db.query(Server)
    if not include_retired:
        query = query.filter(Server.is_managed.is_(True))
    query = filter_servers_query(query, current_user)
    if group_id is not None:
        query = query.filter(Server.group_id == group_id)
    if os_family:
        query = query.filter(Server.os_family == os_family)
    if reboot_required is not None:
        query = query.filter(Server.reboot_required == reboot_required)
    if search:
        term = f"%{search.strip()}%"
        query = query.filter((Server.hostname.ilike(term)) | (Server.ip_address.ilike(term)))
    return query.order_by(Server.hostname).offset(offset).limit(limit).all()


@router.post("", response_model=ServerResponse, status_code=201)
def create_server(
    server_in: ServerCreate,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_operator_or_admin),
):
    assert_server_attributes_in_scope(current_user, server_in.group_id, server_in.os_family)
    existing = db.query(Server).filter(
        (Server.ip_address == server_in.ip_address) | (Server.hostname == server_in.hostname)
    ).first()
    if existing:
        raise HTTPException(status_code=409, detail="A managed server already uses this hostname or IP address")
    awx_cred_id = server_in.awx_credential_id
    if server_in.group_id is not None:
        group = db.query(ServerGroup).filter(ServerGroup.id == server_in.group_id).first()
        if not group:
            raise HTTPException(status_code=404, detail="Server group not found")
        # Credential inheritance: if not explicitly supplied, inherit customer default
        if awx_cred_id is None:
            if server_in.os_family == OSFamilyEnum.WINDOWS and group.default_windows_credential_id:
                awx_cred_id = group.default_windows_credential_id
            elif server_in.os_family == OSFamilyEnum.LINUX and group.default_linux_credential_id:
                awx_cred_id = group.default_linux_credential_id

    if awx_cred_id is not None:
        _validate_awx_machine_credential(awx_cred_id)

    server = Server(
        hostname=server_in.hostname,
        ip_address=server_in.ip_address,
        os_family=server_in.os_family,
        os_name=server_in.os_name,
        os_version=server_in.os_version,
        awx_credential_id=awx_cred_id,
        winrm_cert_validation=server_in.winrm_cert_validation if server_in.os_family == OSFamilyEnum.WINDOWS else None,
        group_id=server_in.group_id,
        connection_status=ConnectionStatusEnum.OFFLINE,
        last_discovered_at=None,
    )
    db.add(server)
    db.flush()
    db.add(AuditLog(
        username=current_user.username,
        action="CREATE_SERVER",
        target_resource=server.hostname,
        details=f"Added {server.hostname} ({server.ip_address})",
        ip_address=request.client.host if request.client else None,
    ))
    db.commit()
    db.refresh(server)
    return server


@router.post("/{server_id}/restore", response_model=ServerResponse)
def restore_server(
    server_id: int,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    server = db.query(Server).filter(
        Server.id == server_id,
        Server.is_managed.is_(False),
    ).with_for_update().first()
    if not server:
        raise HTTPException(status_code=404, detail="Retired server not found")
    server.is_managed = True
    server.connection_status = ConnectionStatusEnum.OFFLINE
    server.last_discovered_at = None
    server.pending_updates_count = 0
    server.security_updates_count = 0
    server.reboot_required = False
    server.reboot_status_known = False
    db.add(AuditLog(
        username=current_user.username,
        action="RESTORE_SERVER",
        target_resource=server.hostname,
        details=f"Restored {server.hostname} to managed inventory; discovery is required before patching",
        ip_address=request.client.host if request.client else None,
    ))
    db.commit()
    db.refresh(server)
    return server


@router.get("/awx-machine-credentials", response_model=List[AWXMachineCredentialResponse])
def get_awx_machine_credentials(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """Expose credential metadata with OS compatibility classification."""
    try:
        raw_creds = awx_client.list_machine_credentials()
    except AWXClientError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    # Query existing server associations to learn usage patterns
    servers = db.query(Server).filter(Server.is_managed.is_(True), Server.awx_credential_id.isnot(None)).all()
    cred_os_map: dict[int, set[str]] = {}
    for s in servers:
        cred_os_map.setdefault(s.awx_credential_id, set()).add(s.os_family.value)

    # Query customer group defaults
    groups = db.query(ServerGroup).all()
    group_linux_creds = {g.default_linux_credential_id for g in groups if g.default_linux_credential_id}
    group_win_creds = {g.default_windows_credential_id for g in groups if g.default_windows_credential_id}

    results = []
    for c in raw_creds:
        c_id = c["id"]
        c_name = c["name"]
        name_lower = c_name.lower()

        # Heuristic 1: Name keywords
        is_win_name = any(kw in name_lower for kw in ["win", "winrm", "windows", "domain", "ad"])
        is_linux_name = any(kw in name_lower for kw in ["ssh", "linux", "ubuntu", "rhel", "centos", "debian"])

        # Heuristic 2: Group defaults
        is_win_group = c_id in group_win_creds
        is_linux_group = c_id in group_linux_creds

        # Heuristic 3: Server usage
        used_os = cred_os_map.get(c_id, set())

        if (is_win_name or is_win_group or ("windows" in used_os and "linux" not in used_os)) and not (is_linux_name or is_linux_group):
            compat = "windows"
        elif (is_linux_name or is_linux_group or ("linux" in used_os and "windows" not in used_os)) and not (is_win_name or is_win_group):
            compat = "linux"
        else:
            compat = "all"

        results.append(AWXMachineCredentialResponse(
            id=c_id,
            name=c_name,
            os_compatibility=compat,
            description=f"Auto-classified as {compat.upper()} credential" if compat != "all" else "General Machine Credential"
        ))
    return results


@router.get("/{server_id}", response_model=ServerResponse)
def get_server(server_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    server = db.query(Server).filter(Server.id == server_id, Server.is_managed.is_(True)).first()
    if not server:
        raise HTTPException(status_code=404, detail="Server not found")
    assert_server_access(current_user, server)
    return server


@router.put("/{server_id}", response_model=ServerResponse)
def update_server(
    server_id: int,
    server_in: ServerUpdate,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_operator_or_admin),
):
    server = db.query(Server).filter(Server.id == server_id, Server.is_managed.is_(True)).with_for_update().first()
    if not server:
        raise HTTPException(status_code=404, detail="Server not found")
    assert_server_access(current_user, server)
    if _has_active_job(db, server_id):
        raise HTTPException(status_code=409, detail="Server metadata cannot be edited while an update job is pending or running")
    changes = server_in.model_dump(exclude_unset=True)
    target_group = changes.get("group_id", server.group_id)
    target_os = changes.get("os_family", server.os_family)
    assert_server_attributes_in_scope(current_user, target_group, target_os)
    if "group_id" in changes and changes["group_id"] is not None:
        if not db.query(ServerGroup.id).filter(ServerGroup.id == changes["group_id"]).first():
            raise HTTPException(status_code=404, detail="Server group not found")
    for field in ("hostname", "ip_address"):
        if field in changes and changes[field] is not None:
            value = changes[field]
            duplicate = db.query(Server.id).filter(
                getattr(Server, field) == value,
                Server.id != server.id,
                Server.is_managed.is_(True),
            ).first()
            if duplicate:
                raise HTTPException(status_code=409, detail=f"Another managed server uses this {field}")

    effective_credential_id = changes.get("awx_credential_id", server.awx_credential_id)
    if effective_credential_id is not None:
        _validate_awx_machine_credential(effective_credential_id)

    discovery_invalidated = any(
        field in changes and changes[field] != getattr(server, field)
        for field in ("hostname", "ip_address", "os_family", "os_name", "os_version")
    )
    for field, value in changes.items():
        setattr(server, field, value)
    if server.os_family != OSFamilyEnum.WINDOWS:
        server.winrm_cert_validation = None
    if discovery_invalidated:
        server.connection_status = ConnectionStatusEnum.OFFLINE
        server.last_discovered_at = None
        server.pending_updates_count = 0
        server.security_updates_count = 0
        server.reboot_required = False
        server.reboot_status_known = False

    db.add(AuditLog(
        username=current_user.username,
        action="UPDATE_SERVER",
        target_resource=server.hostname,
        details=f"Updated server metadata for {server.hostname}; discovery reset={discovery_invalidated}",
        ip_address=request.client.host if request.client else None,
    ))
    db.commit()
    db.refresh(server)
    return server


@router.delete("/{server_id}", status_code=200)
def delete_server(
    server_id: int,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    server = db.query(Server).filter(Server.id == server_id, Server.is_managed.is_(True)).with_for_update().first()
    if not server:
        raise HTTPException(status_code=404, detail="Server not found")
    if _has_active_job(db, server_id):
        raise HTTPException(status_code=409, detail="Cancel or finish active jobs before retiring this server")
    server.is_managed = False
    server.connection_status = ConnectionStatusEnum.OFFLINE
    db.add(AuditLog(
        username=current_user.username,
        action="RETIRE_SERVER",
        target_resource=server.hostname,
        details=f"Retired server {server.hostname}; historical job records were retained",
        ip_address=request.client.host if request.client else None,
    ))
    db.commit()
    return {"message": f"Server {server.hostname} retired; execution history retained"}


@router.get("/groups/list", response_model=List[ServerGroupResponse])
def get_server_groups(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    group_query = db.query(ServerGroup).order_by(ServerGroup.name)
    if has_group_restriction(current_user):
        group_query = group_query.filter(ServerGroup.id.in_([int(g) for g in (current_user.allowed_group_ids or [])]))
    groups = group_query.all()
    return [
        ServerGroupResponse(
            id=group.id,
            name=group.name,
            description=group.description,
            server_count=sum(1 for server in group.servers if server.is_managed and can_access_server(current_user, server)),
            default_linux_credential_id=group.default_linux_credential_id,
            default_windows_credential_id=group.default_windows_credential_id,
        )
        for group in groups
    ]


@router.post("/groups", response_model=ServerGroupResponse, status_code=201)
def create_server_group(
    group_in: ServerGroupCreate,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    existing = db.query(ServerGroup).filter(ServerGroup.name == group_in.name).first()
    if existing:
        raise HTTPException(status_code=409, detail="Server group with this name already exists")

    if group_in.default_linux_credential_id is not None:
        _validate_awx_machine_credential(group_in.default_linux_credential_id)
    if group_in.default_windows_credential_id is not None:
        _validate_awx_machine_credential(group_in.default_windows_credential_id)

    group = ServerGroup(
        name=group_in.name.strip(),
        description=group_in.description,
        default_linux_credential_id=group_in.default_linux_credential_id,
        default_windows_credential_id=group_in.default_windows_credential_id,
    )
    db.add(group)
    db.flush()
    db.add(AuditLog(
        username=current_user.username,
        action="CREATE_SERVER_GROUP",
        target_resource=group.name,
        details=f"Created server group {group.name}",
        ip_address=request.client.host if request.client else None,
    ))
    db.commit()
    db.refresh(group)
    return ServerGroupResponse(
        id=group.id,
        name=group.name,
        description=group.description,
        server_count=0,
        default_linux_credential_id=group.default_linux_credential_id,
        default_windows_credential_id=group.default_windows_credential_id,
    )


@router.put("/groups/{group_id}", response_model=ServerGroupResponse)
def update_server_group(
    group_id: int,
    group_in: ServerGroupUpdate,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    group = db.query(ServerGroup).filter(ServerGroup.id == group_id).first()
    if not group:
        raise HTTPException(status_code=404, detail="Server group not found")

    if group_in.name is not None:
        trimmed = group_in.name.strip()
        if not trimmed:
            raise HTTPException(status_code=422, detail="Group name cannot be blank")
        existing = db.query(ServerGroup).filter(ServerGroup.name == trimmed, ServerGroup.id != group_id).first()
        if existing:
            raise HTTPException(status_code=409, detail="A server group with this name already exists")
        group.name = trimmed

    if group_in.description is not None:
        group.description = group_in.description

    if group_in.default_linux_credential_id is not None:
        if group_in.default_linux_credential_id > 0:
            _validate_awx_machine_credential(group_in.default_linux_credential_id)
            group.default_linux_credential_id = group_in.default_linux_credential_id
        else:
            group.default_linux_credential_id = None

    if group_in.default_windows_credential_id is not None:
        if group_in.default_windows_credential_id > 0:
            _validate_awx_machine_credential(group_in.default_windows_credential_id)
            group.default_windows_credential_id = group_in.default_windows_credential_id
        else:
            group.default_windows_credential_id = None

    db.add(AuditLog(
        username=current_user.username,
        action="UPDATE_SERVER_GROUP",
        target_resource=group.name,
        details=f"Updated server group {group.name}",
        ip_address=request.client.host if request.client else None,
    ))
    db.commit()
    db.refresh(group)
    return ServerGroupResponse(
        id=group.id,
        name=group.name,
        description=group.description,
        server_count=sum(1 for s in group.servers if s.is_managed),
        default_linux_credential_id=group.default_linux_credential_id,
        default_windows_credential_id=group.default_windows_credential_id,
    )


@router.post("/sync-awx")
def sync_awx_inventory(
    db: Session = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    if settings.AWX_INVENTORY_ID is None:
        raise HTTPException(status_code=409, detail="AWX_INVENTORY_ID is not configured")
    servers = db.query(Server).filter(Server.is_managed.is_(True)).order_by(Server.hostname).all()
    try:
        count = awx_client.sync_inventory_hosts(settings.AWX_INVENTORY_ID, servers)
    except AWXClientError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    db.add(AuditLog(
        username=current_user.username,
        action="SYNC_AWX_INVENTORY",
        target_resource=str(settings.AWX_INVENTORY_ID),
        details=f"Synchronized {count} managed host(s) with AWX inventory",
    ))
    db.commit()
    return {"inventory_id": settings.AWX_INVENTORY_ID, "synchronized_hosts": count}


class BulkAssignGroupRequest(BaseModel):
    server_ids: List[int]
    group_id: Optional[int] = None
    apply_default_credentials: bool = False


@router.post("/bulk-assign-group", response_model=List[ServerResponse])
def bulk_assign_server_group(
    payload: BulkAssignGroupRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_operator_or_admin),
):
    group = None
    if payload.group_id is not None:
        group = db.query(ServerGroup).filter(ServerGroup.id == payload.group_id).first()
        if not group:
            raise HTTPException(status_code=404, detail="Customer / Server Group not found")
    servers = db.query(Server).filter(Server.id.in_(payload.server_ids), Server.is_managed.is_(True)).all()
    assert_servers_access(current_user, servers)
    for s in servers:
        assert_server_attributes_in_scope(current_user, payload.group_id, s.os_family)
        s.group_id = payload.group_id
        if payload.apply_default_credentials and group:
            if s.os_family == OSFamilyEnum.WINDOWS and group.default_windows_credential_id:
                s.awx_credential_id = group.default_windows_credential_id
            elif s.os_family == OSFamilyEnum.LINUX and group.default_linux_credential_id:
                s.awx_credential_id = group.default_linux_credential_id
    db.commit()
    for s in servers:
        db.refresh(s)
    return servers


@router.delete("/groups/{group_id}", status_code=204)
def delete_server_group(
    group_id: int,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    group = db.query(ServerGroup).filter(ServerGroup.id == group_id).first()
    if not group:
        raise HTTPException(status_code=404, detail="Server group not found")
    name = group.name
    for s in group.servers:
        s.group_id = None
    db.delete(group)
    db.add(AuditLog(
        username=current_user.username,
        action="DELETE_SERVER_GROUP",
        target_resource=name,
        details=f"Deleted server group {name}",
        ip_address=request.client.host if request.client else None,
    ))
    db.commit()
    return Response(status_code=204)


def _enforce_no_active_overlap(
    db: Session,
    server_ids: list[int],
    allow_overlap: bool,
    current_user: User,
) -> None:
    if allow_overlap and current_user.role != RoleEnum.ADMIN:
        raise HTTPException(status_code=403, detail="Only administrators may approve overlapping jobs")
    active = db.query(JobServer).join(UpdateJob).filter(
        JobServer.server_id.in_(server_ids),
        UpdateJob.status.in_([JobStatusEnum.PENDING, JobStatusEnum.RUNNING]),
    ).all()
    if active and not allow_overlap:
        names = ", ".join(sorted({record.server_hostname for record in active}))
        raise HTTPException(status_code=409, detail=f"An active job already targets: {names}")


@router.get("/{server_id}/patches", response_model=List[InstalledPatchResponse])
def get_server_installed_patches(
    server_id: int,
    search: Optional[str] = Query(None, max_length=100),
    limit: int = Query(100, ge=1, le=500),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    server = db.query(Server).filter(Server.id == server_id).first()
    if not server:
        raise HTTPException(status_code=404, detail="Server not found")
    assert_server_access(current_user, server)

    query = (
        db.query(InstalledPatch, UpdateJob.build_id)
        .outerjoin(UpdateJob, InstalledPatch.job_id == UpdateJob.id)
        .filter(InstalledPatch.server_id == server_id)
    )
    if search and search.strip():
        term = f"%{search.strip()}%"
        query = query.filter(InstalledPatch.package_or_kb.ilike(term))

    rows = query.order_by(InstalledPatch.installed_at.desc(), InstalledPatch.id.desc()).limit(limit).all()
    return [
        InstalledPatchResponse(
            id=patch.id,
            job_id=patch.job_id,
            build_id=build_id,
            server_id=patch.server_id,
            server_hostname=server.hostname,
            package_or_kb=patch.package_or_kb,
            patch_type=patch.patch_type,
            installed_at=patch.installed_at,
        )
        for patch, build_id in rows
    ]


@router.post("/{server_id}/reboot", response_model=JobDetailResponse, status_code=202)
def reboot_server(
    server_id: int,
    request: Request,
    action: str = Query("reboot"),
    allow_overlap: bool = Query(False),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_operator_or_admin),
):
    server = db.query(Server).filter(
        Server.id == server_id, Server.is_managed.is_(True)
    ).with_for_update().first()
    if not server:
        raise HTTPException(status_code=404, detail="Server not found")
    assert_server_access(current_user, server)

    if action == "clear_flag":
        server.reboot_required = False
        server.reboot_status_known = True
        db.add(AuditLog(
            username=current_user.username,
            action="CLEAR_PENDING_REBOOT",
            target_resource=server.hostname,
            details=f"Operator cleared pending reboot flag on {server.hostname}",
            ip_address=request.client.host if request.client else None,
        ))
        db.commit()
        return JSONResponse(
            status_code=200,
            content={"status": "cleared", "hostname": server.hostname, "reboot_required": False},
        )

    if server.awx_credential_id is None:
        raise HTTPException(status_code=422, detail=f"Select an AWX Machine credential for {server.hostname} before rebooting")

    _enforce_no_active_overlap(db, [server.id], allow_overlap, current_user)

    job = create_job_record(
        db,
        job_name=f"Reboot Action • {server.hostname}",
        update_type=UpdateTypeEnum.REGULAR,
        servers=[server],
        initiated_by=current_user.username,
        overlap_approved=allow_overlap,
        reboot_only=True,
    )
    db.commit()
    db.refresh(job)
    return job


@router.post("/bulk-reboot", response_model=JobDetailResponse, status_code=202)
def bulk_reboot_servers(
    payload: BulkServersRequest,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_operator_or_admin),
):
    unique_ids = list(dict.fromkeys(payload.server_ids))
    if not unique_ids:
        raise HTTPException(status_code=400, detail="No server IDs provided")

    servers = db.query(Server).filter(
        Server.id.in_(unique_ids), Server.is_managed.is_(True)
    ).order_by(Server.id).with_for_update().all()
    if len(servers) != len(unique_ids):
        raise HTTPException(status_code=404, detail="One or more selected servers were not found")
    assert_servers_access(current_user, servers)

    if payload.action == "clear_flag":
        for s in servers:
            s.reboot_required = False
            s.reboot_status_known = True
        db.add(AuditLog(
            username=current_user.username,
            action="BULK_CLEAR_PENDING_REBOOT",
            target_resource=f"{len(servers)} hosts",
            details=f"Operator cleared pending reboot flag on {len(servers)} hosts",
            ip_address=request.client.host if request.client else None,
        ))
        db.commit()
        return JSONResponse(
            status_code=200,
            content={"status": "cleared", "cleared_count": len(servers)},
        )

    missing = [s.hostname for s in servers if s.awx_credential_id is None]
    if missing:
        raise HTTPException(status_code=422, detail="Missing AWX Machine credential for: " + ", ".join(missing))

    _enforce_no_active_overlap(db, unique_ids, payload.allow_overlap, current_user)

    batches: dict[tuple, list[Server]] = {}
    for s in servers:
        batches.setdefault((s.os_family, s.awx_credential_id), []).append(s)

    created_jobs: list[UpdateJob] = []
    batch_id = f"BATCH-{uuid.uuid4().hex[:12].upper()}" if len(batches) > 1 else None

    if len(batches) == 1:
        job = create_job_record(
            db,
            job_name=f"Bulk Reboot • ({len(servers)} hosts)",
            update_type=UpdateTypeEnum.REGULAR,
            servers=servers,
            initiated_by=current_user.username,
            overlap_approved=payload.allow_overlap,
            reboot_only=True,
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
            job = create_job_record(
                db,
                job_name=f"Bulk Reboot • {cred_label} ({len(batch_servers)} hosts)",
                update_type=UpdateTypeEnum.REGULAR,
                servers=batch_servers,
                initiated_by=current_user.username,
                overlap_approved=payload.allow_overlap,
                reboot_only=True,
                batch_id=batch_id,
            )
            created_jobs.append(job)

    db.commit()
    for j in created_jobs:
        db.refresh(j)

    primary_job = created_jobs[0]
    primary_job.batch_build_ids = [j.build_id for j in created_jobs]
    primary_job.batch_count = len(created_jobs)
    return primary_job


@router.post("/{server_id}/reset-windows-cache", response_model=JobDetailResponse, status_code=202)
def reset_windows_cache(
    server_id: int,
    allow_overlap: bool = Query(False),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_operator_or_admin),
):
    server = db.query(Server).filter(
        Server.id == server_id, Server.is_managed.is_(True)
    ).with_for_update().first()
    if not server:
        raise HTTPException(status_code=404, detail="Server not found")
    assert_server_access(current_user, server)
    if server.os_family != OSFamilyEnum.WINDOWS:
        raise HTTPException(status_code=400, detail="Windows Update Cache reset is only supported on Windows servers")
    if server.awx_credential_id is None:
        raise HTTPException(status_code=422, detail=f"Select an AWX Machine credential for {server.hostname}")

    _enforce_no_active_overlap(db, [server.id], allow_overlap, current_user)

    job = create_job_record(
        db,
        job_name=f"Reset WU Cache • {server.hostname}",
        update_type=UpdateTypeEnum.REGULAR,
        servers=[server],
        initiated_by=current_user.username,
        overlap_approved=allow_overlap,
        clean_cache_only=True,
    )
    db.commit()
    db.refresh(job)
    return job


@router.post("/bulk-reset-windows-cache", response_model=JobDetailResponse, status_code=202)
def bulk_reset_windows_cache(
    payload: BulkServersRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_operator_or_admin),
):
    unique_ids = list(dict.fromkeys(payload.server_ids))
    if not unique_ids:
        raise HTTPException(status_code=400, detail="No server IDs provided")

    servers = db.query(Server).filter(
        Server.id.in_(unique_ids),
        Server.is_managed.is_(True),
        Server.os_family == OSFamilyEnum.WINDOWS,
    ).order_by(Server.id).with_for_update().all()

    if not servers:
        raise HTTPException(status_code=400, detail="No Windows servers selected for cache reset")
    assert_servers_access(current_user, servers)

    missing = [s.hostname for s in servers if s.awx_credential_id is None]
    if missing:
        raise HTTPException(status_code=422, detail="Missing AWX Machine credential for: " + ", ".join(missing))

    _enforce_no_active_overlap(db, [s.id for s in servers], payload.allow_overlap, current_user)

    batches: dict[int, list[Server]] = {}
    for s in servers:
        batches.setdefault(s.awx_credential_id, []).append(s)

    created_jobs: list[UpdateJob] = []
    batch_id = f"BATCH-{uuid.uuid4().hex[:12].upper()}" if len(batches) > 1 else None

    if len(batches) == 1:
        job = create_job_record(
            db,
            job_name=f"Reset WU Cache • ({len(servers)} Windows hosts)",
            update_type=UpdateTypeEnum.REGULAR,
            servers=servers,
            initiated_by=current_user.username,
            overlap_approved=payload.allow_overlap,
            clean_cache_only=True,
        )
        created_jobs.append(job)
    else:
        cred_name_map = {}
        try:
            creds = awx_client.list_machine_credentials()
            cred_name_map = {c["id"]: c["name"] for c in creds if isinstance(c.get("id"), int)}
        except Exception:
            pass

        for cred_id, batch_servers in sorted(batches.items()):
            cred_label = cred_name_map.get(cred_id, f"Credential #{cred_id}")
            job = create_job_record(
                db,
                job_name=f"Reset WU Cache • {cred_label} ({len(batch_servers)} hosts)",
                update_type=UpdateTypeEnum.REGULAR,
                servers=batch_servers,
                initiated_by=current_user.username,
                overlap_approved=payload.allow_overlap,
                clean_cache_only=True,
                batch_id=batch_id,
            )
            created_jobs.append(job)

    db.commit()
    for j in created_jobs:
        db.refresh(j)

    primary_job = created_jobs[0]
    primary_job.batch_build_ids = [j.build_id for j in created_jobs]
    primary_job.batch_count = len(created_jobs)
    return primary_job
