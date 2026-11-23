"""Baseline compatibility and durable AWX execution metadata.

This revision is safe for both a fresh database and the deployed schema created
with SQLAlchemy create_all. It fills in missing tables and adds new columns
without replacing existing records.
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect

from app.database import Base
from app.models import models  # noqa: F401 - registers mapped tables

revision = "20261112_0001"
down_revision = None
branch_labels = None
depends_on = None


def _has_column(bind, table_name: str, column_name: str) -> bool:
    inspector = inspect(bind)
    return table_name in inspector.get_table_names() and any(
        column["name"] == column_name for column in inspector.get_columns(table_name)
    )


def _add_column_if_missing(bind, table_name: str, column: sa.Column) -> None:
    if not _has_column(bind, table_name, column.name):
        op.add_column(table_name, column)


def upgrade() -> None:
    bind = op.get_bind()
    existing_tables = set(inspect(bind).get_table_names())
    legacy_inventory = "servers" in existing_tables and not _has_column(bind, "servers", "is_managed")
    legacy_schedules = "schedules" in existing_tables
    legacy_jobs = "update_jobs" in existing_tables
    if bind.dialect.name == "postgresql":
        enum_names = {item["name"] for item in inspect(bind).get_enums()}
        if "updatetypeenum" in enum_names:
            op.execute("ALTER TYPE updatetypeenum ADD VALUE IF NOT EXISTS 'DISCOVERY'")
        if "stagestatusenum" in enum_names:
            op.execute("ALTER TYPE stagestatusenum ADD VALUE IF NOT EXISTS 'CANCELLED'")

    # Creates missing tables and indexes; SQLAlchemy intentionally does not
    # alter existing tables, so existing columns are migrated below.
    Base.metadata.create_all(bind=bind)

    _add_column_if_missing(bind, "update_jobs", sa.Column("raw_logs", sa.Text(), nullable=True))
    _add_column_if_missing(
        bind,
        "update_jobs",
        sa.Column("major_upgrade_approved", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    _add_column_if_missing(
        bind,
        "update_jobs",
        sa.Column("backup_verified", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    _add_column_if_missing(
        bind,
        "update_jobs",
        sa.Column("overlap_approved", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    _add_column_if_missing(bind, "update_jobs", sa.Column("scheduled_for", sa.DateTime(), nullable=True))
    _add_column_if_missing(
        bind,
        "servers",
        sa.Column("is_managed", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    _add_column_if_missing(
        bind,
        "servers",
        sa.Column("reboot_status_known", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    _add_column_if_missing(
        bind,
        "schedules",
        sa.Column("created_by", sa.String(length=50), nullable=False, server_default="system"),
    )

    # Legacy inventory and schedules were seeded/never dispatched by the old
    # application. Retain their records, but require an administrator to review
    # targets and explicitly restore hosts or re-enable schedules after deploy.
    if legacy_inventory:
        op.execute(
            "UPDATE servers SET is_managed = false, connection_status = 'OFFLINE', "
            "last_discovered_at = NULL, pending_updates_count = 0, security_updates_count = 0, "
            "reboot_required = false, reboot_status_known = false"
        )
    if legacy_schedules:
        op.execute("UPDATE schedules SET is_active = false, next_run_at = NULL")
    if legacy_jobs:
        tables_after_create = set(inspect(bind).get_table_names())
        if "pipeline_stages" in tables_after_create and "job_servers" in tables_after_create:
            op.execute(
                "UPDATE pipeline_stages SET status = 'SKIPPED' "
                "WHERE status = 'PENDING' AND job_server_id IN ("
                "SELECT js.id FROM job_servers js JOIN update_jobs j ON j.id = js.job_id WHERE j.status = 'PENDING')"
            )
            op.execute(
                "UPDATE job_servers SET status = 'CANCELLED', end_time = CURRENT_TIMESTAMP, "
                "error_details = 'Legacy queued job cancelled during migration; review targets before retrying' "
                "WHERE job_id IN (SELECT id FROM update_jobs WHERE status = 'PENDING')"
            )
            op.execute(
                "UPDATE pipeline_stages SET status = 'FAILED', end_time = CURRENT_TIMESTAMP "
                "WHERE status = 'RUNNING' AND job_server_id IN ("
                "SELECT js.id FROM job_servers js JOIN update_jobs j ON j.id = js.job_id "
                "WHERE j.status = 'RUNNING' AND j.awx_job_id IS NULL)"
            )
            op.execute(
                "UPDATE pipeline_stages SET status = 'SKIPPED' "
                "WHERE status = 'PENDING' AND job_server_id IN ("
                "SELECT js.id FROM job_servers js JOIN update_jobs j ON j.id = js.job_id "
                "WHERE j.status = 'RUNNING' AND j.awx_job_id IS NULL)"
            )
            op.execute(
                "UPDATE job_servers SET status = 'FAILED', end_time = CURRENT_TIMESTAMP, "
                "error_details = 'Legacy running job has no AWX job ID; inspect AWX before retrying' "
                "WHERE job_id IN (SELECT id FROM update_jobs WHERE status = 'RUNNING' AND awx_job_id IS NULL)"
            )
        op.execute(
            "UPDATE update_jobs SET status = 'CANCELLED', end_time = CURRENT_TIMESTAMP, "
            "error_summary = CASE WHEN error_summary IS NULL OR error_summary = '' "
            "THEN 'Legacy queued job cancelled during migration; review targets before retrying' ELSE error_summary END "
            "WHERE status = 'PENDING'"
        )
        op.execute(
            "UPDATE update_jobs SET status = 'FAILED', end_time = CURRENT_TIMESTAMP, "
            "failed_servers = total_servers, "
            "error_summary = CASE WHEN error_summary IS NULL OR error_summary = '' "
            "THEN 'Legacy running job had no AWX job ID; inspect AWX before retrying' ELSE error_summary END "
            "WHERE status = 'RUNNING' AND awx_job_id IS NULL"
        )

    for table_name, column_name in (
        ("update_jobs", "major_upgrade_approved"),
        ("update_jobs", "backup_verified"),
        ("update_jobs", "overlap_approved"),
        ("servers", "is_managed"),
        ("servers", "reboot_status_known"),
        ("schedules", "created_by"),
    ):
        if bind.dialect.name == "postgresql" and _has_column(bind, table_name, column_name):
            op.alter_column(table_name, column_name, server_default=None)


def downgrade() -> None:
    bind = op.get_bind()
    if "job_events" in inspect(bind).get_table_names():
        op.drop_table("job_events")
    for table_name, column_name in (
        ("schedules", "created_by"),
        ("servers", "is_managed"),
        ("servers", "reboot_status_known"),
        ("update_jobs", "scheduled_for"),
        ("update_jobs", "backup_verified"),
        ("update_jobs", "overlap_approved"),
        ("update_jobs", "major_upgrade_approved"),
        ("update_jobs", "raw_logs"),
    ):
        if _has_column(bind, table_name, column_name):
            op.drop_column(table_name, column_name)

    if bind.dialect.name == "postgresql":
        # PostgreSQL cannot remove an enum value without rebuilding the type.
        pass
