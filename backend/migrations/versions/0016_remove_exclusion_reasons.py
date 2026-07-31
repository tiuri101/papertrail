"""remove exclusion reasons

Revision ID: 0016
Revises: 0015
Create Date: 2026-07-31 00:00:00.000000
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0016"
down_revision: str | None = "0015"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_constraint(
        op.f("fk_screening_decisions_exclusion_reason_id_exclusion_reasons"),
        "screening_decisions",
        type_="foreignkey",
    )
    op.drop_column("screening_decisions", "exclusion_reason_id")
    op.drop_column("screening_decisions", "exclusion_reason_text")
    op.drop_index(
        op.f("ix_exclusion_reasons_project_id"), table_name="exclusion_reasons"
    )
    op.drop_table("exclusion_reasons")


def downgrade() -> None:
    op.create_table(
        "exclusion_reasons",
        sa.Column("project_id", sa.String(length=36), nullable=False),
        sa.Column(
            "stage",
            sa.Enum("TITLE_ABSTRACT", "FULL_TEXT", name="screeningstage"),
            nullable=False,
        ),
        sa.Column("label", sa.String(length=300), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False),
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(
            ["project_id"],
            ["projects.id"],
            name=op.f("fk_exclusion_reasons_project_id_projects"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_exclusion_reasons")),
    )
    op.create_index(
        op.f("ix_exclusion_reasons_project_id"),
        "exclusion_reasons",
        ["project_id"],
        unique=False,
    )
    op.add_column(
        "screening_decisions",
        sa.Column(
            "exclusion_reason_text", sa.String(length=300), nullable=True
        ),
    )
    op.add_column(
        "screening_decisions",
        sa.Column("exclusion_reason_id", sa.String(length=36), nullable=True),
    )
    op.create_foreign_key(
        op.f("fk_screening_decisions_exclusion_reason_id_exclusion_reasons"),
        "screening_decisions",
        "exclusion_reasons",
        ["exclusion_reason_id"],
        ["id"],
        ondelete="SET NULL",
    )
