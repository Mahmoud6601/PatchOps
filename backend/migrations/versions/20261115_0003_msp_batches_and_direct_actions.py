"""Add MSP group default credentials, batch correlation, retry links, and direct action flags."""

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect


revision = "20261115_0003"
down_revision = "20261113_0002"
branch_labels = None
depends_on = None


def _has_column(bind, table_name: str, column_name: str) -> bool:
    inspector = inspect(bind)
    return table_name in inspector.get_table_names() and any(
        column["name"] == column_name for column in inspector.get_columns(table_name)
    )


def upgrade() -> None:
    bind = op.get_bind()

    if not _has_column(bind, "server_groups", "default_linux_credential_id"):
        op.add_column("server_groups", sa.Column("default_linux_credential_id", sa.Integer(), nullable=True))
    if not _has_column(bind, "server_groups", "default_windows_credential_id"):
        op.add_column("server_groups", sa.Column("default_windows_credential_id", sa.Integer(), nullable=True))

    if not _has_column(bind, "update_jobs", "batch_id"):
        op.add_column("update_jobs", sa.Column("batch_id", sa.String(length=50), nullable=True))
        op.create_index("ix_update_jobs_batch_id", "update_jobs", ["batch_id"], unique=False)
    if not _has_column(bind, "update_jobs", "reboot_only"):
        op.add_column(
            "update_jobs",
            sa.Column("reboot_only", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        )
    if not _has_column(bind, "update_jobs", "clean_cache_only"):
        op.add_column(
            "update_jobs",
            sa.Column("clean_cache_only", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        )
    if not _has_column(bind, "update_jobs", "retry_of_build_id"):
        op.add_column("update_jobs", sa.Column("retry_of_build_id", sa.String(length=50), nullable=True))


def downgrade() -> None:
    bind = op.get_bind()

    if _has_column(bind, "update_jobs", "retry_of_build_id"):
        op.drop_column("update_jobs", "retry_of_build_id")
    if _has_column(bind, "update_jobs", "clean_cache_only"):
        op.drop_column("update_jobs", "clean_cache_only")
    if _has_column(bind, "update_jobs", "reboot_only"):
        op.drop_column("update_jobs", "reboot_only")
    if _has_column(bind, "update_jobs", "batch_id"):
        op.drop_index("ix_update_jobs_batch_id", table_name="update_jobs")
        op.drop_column("update_jobs", "batch_id")

    if _has_column(bind, "server_groups", "default_windows_credential_id"):
        op.drop_column("server_groups", "default_windows_credential_id")
    if _has_column(bind, "server_groups", "default_linux_credential_id"):
        op.drop_column("server_groups", "default_linux_credential_id")
