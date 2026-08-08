"""add LLM screening assistance and extraction validation

Revision ID: 0005_llm_screening_validation
Revises: 0004_duplicate_scoring
Create Date: 2026-08-08
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0005_llm_screening_validation"
down_revision: str | None = "0004_duplicate_scoring"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

json_type = sa.JSON().with_variant(
    postgresql.JSONB(astext_type=sa.Text()), "postgresql"
)


def timestamps() -> list[sa.Column]:
    return [
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    ]


def upgrade() -> None:
    for column in (
        "title_abstract_screening_enabled",
        "full_text_screening_enabled",
        "extraction_validation_enabled",
    ):
        op.add_column(
            "project_llm_settings",
            sa.Column(column, sa.Boolean(), server_default=sa.false(), nullable=False),
        )

    op.drop_index("uq_llm_active_run", table_name="llm_extraction_runs")
    op.add_column(
        "llm_extraction_runs",
        sa.Column(
            "task_type",
            sa.String(length=40),
            server_default="data_extraction",
            nullable=False,
        ),
    )
    op.add_column(
        "llm_extraction_runs", sa.Column("input_fingerprint", sa.String(length=64))
    )
    op.add_column("llm_extraction_runs", sa.Column("model_configuration", json_type))
    op.add_column(
        "llm_extraction_runs",
        sa.Column("extraction_response_id", sa.String(length=36)),
    )
    op.create_foreign_key(
        "fk_llm_runs_extraction_response",
        "llm_extraction_runs",
        "extraction_responses",
        ["extraction_response_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.alter_column("llm_extraction_runs", "document_id", nullable=True)
    op.alter_column("llm_extraction_runs", "schema_version_id", nullable=True)
    op.alter_column("llm_extraction_runs", "text_extraction_id", nullable=True)
    for column in ("task_type", "input_fingerprint", "extraction_response_id"):
        op.create_index(
            f"ix_llm_extraction_runs_{column}", "llm_extraction_runs", [column]
        )
    op.create_index(
        "uq_llm_active_run",
        "llm_extraction_runs",
        ["publication_id", "task_type", "input_fingerprint"],
        unique=True,
        postgresql_where=sa.text("status IN ('pending', 'processing')"),
        sqlite_where=sa.text("status IN ('pending', 'processing')"),
    )

    op.create_table(
        "llm_criterion_suggestions",
        sa.Column("run_id", sa.String(length=36), nullable=False),
        sa.Column("criterion_id", sa.String(length=36)),
        sa.Column("criterion_text", sa.Text(), nullable=False),
        sa.Column("criterion_kind", sa.String(length=20), nullable=False),
        sa.Column("assessment", sa.String(length=20), nullable=False),
        sa.Column("explanation", sa.Text(), nullable=False),
        sa.Column("evidence", json_type, nullable=False),
        sa.Column("evidence_validation_status", sa.String(length=20), nullable=False),
        *timestamps(),
        sa.ForeignKeyConstraint(
            ["run_id"], ["llm_extraction_runs.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(["criterion_id"], ["criteria.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("run_id", "criterion_id", name="uq_llm_run_criterion"),
    )
    op.create_index(
        "ix_llm_criterion_suggestions_run_id",
        "llm_criterion_suggestions",
        ["run_id"],
    )
    op.create_index(
        "ix_llm_criterion_suggestions_criterion_id",
        "llm_criterion_suggestions",
        ["criterion_id"],
    )

    op.create_table(
        "llm_validation_results",
        sa.Column("run_id", sa.String(length=36), nullable=False),
        sa.Column("extraction_field_key", sa.String(length=36), nullable=False),
        sa.Column("field_label", sa.String(length=300), nullable=False),
        sa.Column("value_snapshot", json_type),
        sa.Column("assessment", sa.String(length=30), nullable=False),
        sa.Column("explanation", sa.Text(), nullable=False),
        sa.Column("evidence", json_type, nullable=False),
        sa.Column("evidence_validation_status", sa.String(length=20), nullable=False),
        *timestamps(),
        sa.ForeignKeyConstraint(
            ["run_id"], ["llm_extraction_runs.id"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "run_id", "extraction_field_key", name="uq_llm_validation_field"
        ),
    )
    op.create_index(
        "ix_llm_validation_results_run_id", "llm_validation_results", ["run_id"]
    )
    op.create_index(
        "ix_llm_validation_results_extraction_field_key",
        "llm_validation_results",
        ["extraction_field_key"],
    )


def downgrade() -> None:
    op.drop_table("llm_validation_results")
    op.drop_table("llm_criterion_suggestions")
    # The previous schema can represent extraction runs only. Remove the new
    # task kinds before restoring its required document/schema/text columns.
    op.execute("DELETE FROM llm_extraction_runs WHERE task_type <> 'data_extraction'")
    op.drop_index("uq_llm_active_run", table_name="llm_extraction_runs")
    for column in ("extraction_response_id", "input_fingerprint", "task_type"):
        op.drop_index(
            f"ix_llm_extraction_runs_{column}", table_name="llm_extraction_runs"
        )
    op.drop_constraint(
        "fk_llm_runs_extraction_response", "llm_extraction_runs", type_="foreignkey"
    )
    op.drop_column("llm_extraction_runs", "extraction_response_id")
    op.drop_column("llm_extraction_runs", "input_fingerprint")
    op.drop_column("llm_extraction_runs", "model_configuration")
    op.drop_column("llm_extraction_runs", "task_type")
    op.alter_column("llm_extraction_runs", "text_extraction_id", nullable=False)
    op.alter_column("llm_extraction_runs", "schema_version_id", nullable=False)
    op.alter_column("llm_extraction_runs", "document_id", nullable=False)
    op.create_index(
        "uq_llm_active_run",
        "llm_extraction_runs",
        ["document_id", "schema_version_id"],
        unique=True,
        postgresql_where=sa.text("status IN ('pending', 'processing')"),
        sqlite_where=sa.text("status IN ('pending', 'processing')"),
    )
    for column in (
        "extraction_validation_enabled",
        "full_text_screening_enabled",
        "title_abstract_screening_enabled",
    ):
        op.drop_column("project_llm_settings", column)
