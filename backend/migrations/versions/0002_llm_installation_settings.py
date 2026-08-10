"""add administrator-managed LLM installation settings

Revision ID: 0002_llm_installation_settings
Revises: 0001_initial_schema
Create Date: 2026-08-10
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0002_llm_installation_settings"
down_revision: str | None = "0001_initial_schema"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "llm_installation_settings",
        sa.Column("enabled", sa.Boolean(), nullable=False),
        sa.Column("endpoint", sa.String(length=2000), nullable=True),
        sa.Column("model", sa.String(length=250), nullable=True),
        sa.Column("context_length", sa.Integer(), nullable=False),
        sa.Column("updated_by_user_id", sa.String(length=36), nullable=True),
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(
            ["updated_by_user_id"], ["users.id"], ondelete="SET NULL"
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_llm_installation_settings")),
    )


def downgrade() -> None:
    op.drop_table("llm_installation_settings")
