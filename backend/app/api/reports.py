import csv
import io
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.models.models import (
    ConnectionStatusEnum,
    JobServer,
    JobStatusEnum,
    OSFamilyEnum,
    Server,
    ServerGroup,
    UpdateJob,
    User,
)
from app.schemas.schemas import CustomerSummary, DashboardSummary
from app.services.auth_service import get_current_user
from app.services.rbac_service import (
    accessible_server_ids_subquery,
    can_access_server,
    filter_jobs_query,
    filter_servers_query,
    has_group_restriction,
    is_unrestricted_user,
)

router = APIRouter(prefix="/reports", tags=["Reports & Analytics"])


@router.get("/summary", response_model=DashboardSummary)
def get_dashboard_summary(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    managed = Server.is_managed.is_(True)
    fresh_cutoff = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(hours=settings.DISCOVERY_MAX_AGE_HOURS)
    fresh = Server.last_discovered_at >= fresh_cutoff

    base_srv_q = filter_servers_query(db.query(Server).filter(managed), current_user)
    total_servers = base_srv_q.count()
    online_servers = base_srv_q.filter(Server.connection_status == ConnectionStatusEnum.ONLINE).count()
    offline_servers = total_servers - online_servers
    servers_requiring_updates = base_srv_q.filter(fresh, Server.pending_updates_count > 0).count()
    sec_q = filter_servers_query(
        db.query(func.coalesce(func.sum(Server.security_updates_count), 0)).filter(managed, fresh),
        current_user,
    )
    security_updates_available = sec_q.scalar() or 0
    servers_requiring_reboot = base_srv_q.filter(
        fresh,
        Server.reboot_status_known.is_(True),
        Server.reboot_required.is_(True),
    ).count()

    base_job_q = filter_jobs_query(db, db.query(UpdateJob), current_user)
    pending_jobs = base_job_q.filter(UpdateJob.status == JobStatusEnum.PENDING).count()
    running_jobs = base_job_q.filter(UpdateJob.status == JobStatusEnum.RUNNING).count()
    successful_jobs = base_job_q.filter(UpdateJob.status == JobStatusEnum.SUCCESS).count()
    failed_jobs = base_job_q.filter(UpdateJob.status == JobStatusEnum.FAILED).count()
    recent_builds = base_job_q.order_by(UpdateJob.created_at.desc(), UpdateJob.id.desc()).limit(10).all()

    groups_q = db.query(ServerGroup).order_by(ServerGroup.name)
    if has_group_restriction(current_user):
        groups_q = groups_q.filter(ServerGroup.id.in_([int(g) for g in (current_user.allowed_group_ids or [])]))
    groups = groups_q.all()
    customer_summaries: list[CustomerSummary] = []

    def compute_summary(group_id_val, name_val, desc_val, server_list):
        tot = len(server_list)
        if tot == 0:
            return CustomerSummary(
                id=group_id_val,
                name=name_val,
                description=desc_val,
                total_servers=0,
                online_servers=0,
                offline_servers=0,
                windows_servers=0,
                linux_servers=0,
                pending_updates_count=0,
                security_updates_count=0,
                reboot_required_count=0,
                compliance_rate=100.0,
                health_status="healthy",
            )
        onl = sum(1 for s in server_list if s.connection_status == ConnectionStatusEnum.ONLINE)
        off = tot - onl
        wins = sum(1 for s in server_list if s.os_family == OSFamilyEnum.WINDOWS)
        lins = sum(1 for s in server_list if s.os_family == OSFamilyEnum.LINUX)
        pend = sum(s.pending_updates_count or 0 for s in server_list)
        sec = sum(s.security_updates_count or 0 for s in server_list)
        reb = sum(1 for s in server_list if s.reboot_required)
        compliant = sum(
            1
            for s in server_list
            if (s.pending_updates_count or 0) == 0
            and not s.reboot_required
            and s.connection_status == ConnectionStatusEnum.ONLINE
        )
        comp_rate = round((compliant / tot) * 100.0, 1)

        if sec > 0 or off > 0:
            h_status = "critical"
        elif pend > 0 or reb > 0 or comp_rate < 100.0:
            h_status = "warning"
        else:
            h_status = "healthy"

        return CustomerSummary(
            id=group_id_val,
            name=name_val,
            description=desc_val,
            total_servers=tot,
            online_servers=onl,
            offline_servers=off,
            windows_servers=wins,
            linux_servers=lins,
            pending_updates_count=pend,
            security_updates_count=sec,
            reboot_required_count=reb,
            compliance_rate=comp_rate,
            health_status=h_status,
        )

    for g in groups:
        g_servers = [s for s in g.servers if s.is_managed and can_access_server(current_user, s)]
        customer_summaries.append(compute_summary(g.id, g.name, g.description, g_servers))

    if not has_group_restriction(current_user):
        unassigned = filter_servers_query(
            db.query(Server).filter(Server.is_managed.is_(True), Server.group_id.is_(None)),
            current_user,
        ).all()
        if unassigned:
            customer_summaries.append(
                compute_summary(
                    None,
                    "Unassigned / General Fleet",
                    "Servers not assigned to a customer tenant",
                    unassigned,
                )
            )

    return DashboardSummary(
        total_servers=total_servers,
        online_servers=online_servers,
        offline_servers=offline_servers,
        servers_requiring_updates=servers_requiring_updates,
        security_updates_available=int(security_updates_available),
        servers_requiring_reboot=servers_requiring_reboot,
        pending_jobs=pending_jobs,
        running_jobs=running_jobs,
        successful_jobs=successful_jobs,
        failed_jobs=failed_jobs,
        recent_builds=recent_builds,
        customer_summaries=customer_summaries,
    )


@router.get("/patch-history.csv")
def export_patch_history(
    start: Optional[datetime] = Query(None),
    end: Optional[datetime] = Query(None),
    hostname: Optional[str] = Query(None, max_length=100),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    start_utc = start.astimezone(timezone.utc).replace(tzinfo=None) if start and start.tzinfo else start
    end_utc = end.astimezone(timezone.utc).replace(tzinfo=None) if end and end.tzinfo else end
    query = db.query(UpdateJob, JobServer).join(JobServer, JobServer.job_id == UpdateJob.id)
    if not is_unrestricted_user(current_user):
        srv_sub = accessible_server_ids_subquery(db, current_user)
        query = query.filter(JobServer.server_id.in_(srv_sub))
    if start_utc:
        query = query.filter(UpdateJob.created_at >= start_utc)
    if end_utc:
        query = query.filter(UpdateJob.created_at <= end_utc)
    if hostname:
        query = query.filter(JobServer.server_hostname.ilike(f"%{hostname.strip()}%"))

    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow([
        "Run ID", "Job Name", "Update Type", "Initiated By", "Overlap Approved", "Scheduled For",
        "Server", "IP", "Overall Status", "Duration Seconds", "Reboot Performed", "Error",
    ])
    for job, record in query.order_by(UpdateJob.created_at.desc(), JobServer.server_hostname).all():
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
            record.duration_seconds,
            record.reboot_performed,
            record.error_details or "",
        ])
    return Response(
        content=output.getvalue(),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": "attachment; filename=patch-history.csv"},
    )
