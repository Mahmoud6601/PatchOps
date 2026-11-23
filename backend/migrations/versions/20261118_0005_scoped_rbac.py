"""Add granular RBAC scope columns (allowed_group_ids, allowed_os_families) to users."""

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect


revision = "20261118_0005"
down_revision = "20261118_0004"
branch_labels = None
depends_on = None


def _has_column(bind, table_name: str, column_name: str) -> bool:
    inspector = inspect(bind)
    return table_name in inspector.get_table_names() and any(
        column["name"] == column_name for column in inspector.get_columns(table_name)
    )


def upgrade() -> None:
    bind = op.get_bind()

    if not _has_column(bind, "users", "allowed_group_ids"):
        op.add_column("users", sa.Column("allowed_group_ids", sa.JSON(), nullable=True))

    if not _has_column(bind, "users", "allowed_os_families"):
        op.add_column("users", sa.Column("allowed_os_families", sa.JSON(), nullable=True))


def downgrade() -> None:
    bind = op.get_bind()

    if _has_column(bind, "users", "allowed_os_families"):
        op.drop_column("users", "allowed_os_families")

    if _has_column(bind, "users", "allowed_group_ids"):
        op.drop_column("users", "allowed_group_ids")
