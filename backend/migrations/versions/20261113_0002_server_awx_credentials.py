"""Store the AWX Machine credential chosen for each Windows server."""

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect


revision = "20261113_0002"
down_revision = "20261112_0001"
branch_labels = None
depends_on = None


def _has_column(bind, table_name: str, column_name: str) -> bool:
    inspector = inspect(bind)
    return table_name in inspector.get_table_names() and any(
        column["name"] == column_name for column in inspector.get_columns(table_name)
    )


def upgrade() -> None:
    bind = op.get_bind()
    if not _has_column(bind, "servers", "awx_credential_id"):
        op.add_column("servers", sa.Column("awx_credential_id", sa.Integer(), nullable=True))


def downgrade() -> None:
    bind = op.get_bind()
    if _has_column(bind, "servers", "awx_credential_id"):
        op.drop_column("servers", "awx_credential_id")
