"""add reviewer workload weight, claim allocation mode, and extraction/quality
allocation configuration

Revision ID: 0003_reviewer_allocation
Revises: 0002_llm_installation_settings
Create Date: 2026-08-10
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0003_reviewer_allocation"
down_revision: str | None = "0002_llm_installation_settings"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# create_type=False: the type is created exactly once via the explicit
# `.create(checkfirst=True)` call below. Without it, each column definition
# that reuses this object below would also try to (and fail to) create it.
task_allocation_mode = postgresql.ENUM(
    "PRE_ASSIGNED", "CLAIM", name="taskallocationmode", create_type=False
)


def upgrade() -> None:
    op.add_column(
        "project_memberships",
        sa.Column("workload_weight", sa.Float(), server_default="1", nullable=False),
    )

    bind = op.get_bind()
    if bind.dialect.name == "postgresql":
        op.execute("ALTER TYPE allocationmode ADD VALUE IF NOT EXISTS 'CLAIM'")
    task_allocation_mode.create(bind, checkfirst=True)

    op.add_column(
        "quality_configs",
        sa.Column(
            "allocation_mode",
            task_allocation_mode,
            server_default="CLAIM",
            nullable=False,
        ),
    )

    op.create_table(
        "extraction_configs",
        sa.Column(
            "allocation_mode",
            task_allocation_mode,
            server_default="CLAIM",
            nullable=False,
        ),
        sa.Column("project_id", sa.String(length=36), nullable=False),
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(
            ["project_id"],
            ["projects.id"],
            name=op.f("fk_extraction_configs_project_id_projects"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_extraction_configs")),
        sa.UniqueConstraint("project_id", name="uq_extraction_config_project"),
    )
    op.create_index(
        op.f("ix_extraction_configs_project_id"),
        "extraction_configs",
        ["project_id"],
        unique=False,
    )

    op.drop_constraint(
        "fk_extraction_work_items_assigned_reviewer_id_users",
        "extraction_work_items",
        type_="foreignkey",
    )
    op.alter_column("extraction_work_items", "assigned_reviewer_id", nullable=True)
    op.create_foreign_key(
        op.f("fk_extraction_work_items_assigned_reviewer_id_users"),
        "extraction_work_items",
        "users",
        ["assigned_reviewer_id"],
        ["id"],
        ondelete="SET NULL",
    )

    op.drop_constraint(
        "fk_quality_work_items_assigned_reviewer_id_users",
        "quality_work_items",
        type_="foreignkey",
    )
    op.alter_column("quality_work_items", "assigned_reviewer_id", nullable=True)
    op.create_foreign_key(
        op.f("fk_quality_work_items_assigned_reviewer_id_users"),
        "quality_work_items",
        "users",
        ["assigned_reviewer_id"],
        ["id"],
        ondelete="SET NULL",
    )


def downgrade() -> None:
    op.drop_constraint(
        "fk_quality_work_items_assigned_reviewer_id_users",
        "quality_work_items",
        type_="foreignkey",
    )
    op.alter_column("quality_work_items", "assigned_reviewer_id", nullable=False)
    op.create_foreign_key(
        op.f("fk_quality_work_items_assigned_reviewer_id_users"),
        "quality_work_items",
        "users",
        ["assigned_reviewer_id"],
        ["id"],
        ondelete="CASCADE",
    )

    op.drop_constraint(
        "fk_extraction_work_items_assigned_reviewer_id_users",
        "extraction_work_items",
        type_="foreignkey",
    )
    op.alter_column("extraction_work_items", "assigned_reviewer_id", nullable=False)
    op.create_foreign_key(
        op.f("fk_extraction_work_items_assigned_reviewer_id_users"),
        "extraction_work_items",
        "users",
        ["assigned_reviewer_id"],
        ["id"],
        ondelete="CASCADE",
    )

    op.drop_index(
        op.f("ix_extraction_configs_project_id"), table_name="extraction_configs"
    )
    op.drop_table("extraction_configs")
    op.drop_column("quality_configs", "allocation_mode")
    bind = op.get_bind()
    task_allocation_mode.drop(bind, checkfirst=True)
    op.drop_column("project_memberships", "workload_weight")
    # Postgres doesn't support removing a value from an enum type without
    # recreating it; the added 'CLAIM' value is left in place on downgrade.
