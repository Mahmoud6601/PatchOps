"""Add token_version, revoked_tokens blacklist table, and per-server WinRM TLS validation policy."""

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect


revision = "20261118_0004"
down_revision = "20261115_0003"
branch_labels = None
depends_on = None


def _has_table(bind, table_name: str) -> bool:
    inspector = inspect(bind)
    return table_name in inspector.get_table_names()


def _has_column(bind, table_name: str, column_name: str) -> bool:
    inspector = inspect(bind)
    return table_name in inspector.get_table_names() and any(
        column["name"] == column_name for column in inspector.get_columns(table_name)
    )


def upgrade() -> None:
    bind = op.get_bind()

    if not _has_column(bind, "users", "token_version"):
        op.add_column(
            "users",
            sa.Column("token_version", sa.Integer(), nullable=False, server_default=sa.text("0")),
        )

    if not _has_column(bind, "servers", "winrm_cert_validation"):
        op.add_column(
            "servers",
            sa.Column("winrm_cert_validation", sa.String(length=20), nullable=True),
        )

    if not _has_table(bind, "revoked_tokens"):
        op.create_table(
            "revoked_tokens",
            sa.Column("id", sa.Integer(), primary_key=True, nullable=False),
            sa.Column("jti", sa.String(length=64), nullable=False),
            sa.Column("username", sa.String(length=50), nullable=False),
            sa.Column("expires_at", sa.DateTime(), nullable=False),
            sa.Column("revoked_at", sa.DateTime(), nullable=False),
        )
        op.create_index("ix_revoked_tokens_id", "revoked_tokens", ["id"], unique=False)
        op.create_index("ix_revoked_tokens_jti", "revoked_tokens", ["jti"], unique=True)
        op.create_index("ix_revoked_tokens_username", "revoked_tokens", ["username"], unique=False)


def downgrade() -> None:
    bind = op.get_bind()

    if _has_table(bind, "revoked_tokens"):
        op.drop_index("ix_revoked_tokens_username", table_name="revoked_tokens")
        op.drop_index("ix_revoked_tokens_jti", table_name="revoked_tokens")
        op.drop_index("ix_revoked_tokens_id", table_name="revoked_tokens")
        op.drop_table("revoked_tokens")

    if _has_column(bind, "servers", "winrm_cert_validation"):
        op.drop_column("servers", "winrm_cert_validation")

    if _has_column(bind, "users", "token_version"):
        op.drop_column("users", "token_version")
