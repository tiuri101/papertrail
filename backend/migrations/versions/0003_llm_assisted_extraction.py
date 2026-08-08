"""add LLM-assisted extraction

Revision ID: 0003_llm_extraction
Revises: 0002_pdf_documents
Create Date: 2026-08-08
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0003_llm_extraction"
down_revision: str | None = "0002_pdf_documents"
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
    op.add_column(
        "background_jobs",
        sa.Column("priority", sa.Integer(), server_default="0", nullable=False),
    )
    op.create_index("ix_background_jobs_priority", "background_jobs", ["priority"])

    op.create_table(
        "project_llm_settings",
        sa.Column("project_id", sa.String(36), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        sa.Column("current_schema_version_id", sa.String(36)),
        sa.Column("updated_by_user_id", sa.String(36)),
        *timestamps(),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["updated_by_user_id"], ["users.id"], ondelete="SET NULL"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("project_id", name="uq_project_llm_settings"),
    )
    op.create_index(
        "ix_project_llm_settings_project_id", "project_llm_settings", ["project_id"]
    )
    op.create_index(
        "ix_project_llm_settings_current_schema_version_id",
        "project_llm_settings",
        ["current_schema_version_id"],
    )

    op.create_table(
        "llm_schema_versions",
        sa.Column("project_id", sa.String(36), nullable=False),
        sa.Column("version_number", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("based_on_form_version_id", sa.String(36)),
        sa.Column("created_by_user_id", sa.String(36)),
        sa.Column("published_at", sa.DateTime(timezone=True)),
        *timestamps(),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["based_on_form_version_id"], ["form_versions.id"], ondelete="SET NULL"
        ),
        sa.ForeignKeyConstraint(
            ["created_by_user_id"], ["users.id"], ondelete="SET NULL"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "project_id", "version_number", name="uq_llm_schema_version"
        ),
    )
    for column in ("project_id", "status", "based_on_form_version_id"):
        op.create_index(
            f"ix_llm_schema_versions_{column}", "llm_schema_versions", [column]
        )

    op.create_table(
        "llm_schema_fields",
        sa.Column("schema_version_id", sa.String(36), nullable=False),
        sa.Column("stable_key", sa.String(36), nullable=False),
        sa.Column("label", sa.String(300), nullable=False),
        sa.Column("instruction", sa.Text(), nullable=False),
        sa.Column("field_type", sa.String(40), nullable=False),
        sa.Column("mapped_extraction_field_key", sa.String(36)),
        sa.Column("options", json_type, nullable=False),
        sa.Column("evidence_required", sa.Boolean(), nullable=False),
        sa.Column("allow_inferred", sa.Boolean(), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        *timestamps(),
        sa.ForeignKeyConstraint(
            ["schema_version_id"], ["llm_schema_versions.id"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "schema_version_id", "stable_key", name="uq_llm_schema_field_key"
        ),
    )
    for column in ("schema_version_id", "stable_key", "mapped_extraction_field_key"):
        op.create_index(f"ix_llm_schema_fields_{column}", "llm_schema_fields", [column])

    op.create_table(
        "document_text_extractions",
        sa.Column("document_id", sa.String(36), nullable=False),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("extractor", sa.String(100), nullable=False),
        sa.Column("extractor_version", sa.String(50), nullable=False),
        sa.Column("page_count", sa.Integer(), nullable=False),
        sa.Column("total_chars", sa.Integer(), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True)),
        sa.Column("extracted_at", sa.DateTime(timezone=True)),
        sa.Column("error_message", sa.Text()),
        *timestamps(),
        sa.ForeignKeyConstraint(
            ["document_id"], ["publication_documents.id"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("document_id", name="uq_document_text_document"),
    )
    op.create_index(
        "ix_document_text_extractions_document_id",
        "document_text_extractions",
        ["document_id"],
    )
    op.create_index(
        "ix_document_text_extractions_status", "document_text_extractions", ["status"]
    )

    op.create_table(
        "document_page_texts",
        sa.Column("text_extraction_id", sa.String(36), nullable=False),
        sa.Column("page_number", sa.Integer(), nullable=False),
        sa.Column("text", sa.Text(), nullable=False),
        *timestamps(),
        sa.ForeignKeyConstraint(
            ["text_extraction_id"], ["document_text_extractions.id"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "text_extraction_id", "page_number", name="uq_document_page"
        ),
    )
    op.create_index(
        "ix_document_page_texts_text_extraction_id",
        "document_page_texts",
        ["text_extraction_id"],
    )

    op.create_table(
        "llm_extraction_runs",
        sa.Column("project_id", sa.String(36), nullable=False),
        sa.Column("publication_id", sa.String(36), nullable=False),
        sa.Column("document_id", sa.String(36), nullable=False),
        sa.Column("schema_version_id", sa.String(36), nullable=False),
        sa.Column("text_extraction_id", sa.String(36), nullable=False),
        sa.Column("provider", sa.String(40), nullable=False),
        sa.Column("model", sa.String(250), nullable=False),
        sa.Column("prompt_template_version", sa.String(100), nullable=False),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("queued_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True)),
        sa.Column("completed_at", sa.DateTime(timezone=True)),
        sa.Column("error_type", sa.String(100)),
        sa.Column("error_message", sa.Text()),
        sa.Column("raw_result", json_type),
        sa.Column("total_duration", sa.BigInteger()),
        sa.Column("load_duration", sa.BigInteger()),
        sa.Column("prompt_eval_count", sa.Integer()),
        sa.Column("prompt_eval_duration", sa.BigInteger()),
        sa.Column("eval_count", sa.Integer()),
        sa.Column("eval_duration", sa.BigInteger()),
        sa.Column("background_job_id", sa.String(36)),
        *timestamps(),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["publication_id"], ["publications.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["document_id"], ["publication_documents.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["schema_version_id"], ["llm_schema_versions.id"], ondelete="RESTRICT"
        ),
        sa.ForeignKeyConstraint(
            ["text_extraction_id"],
            ["document_text_extractions.id"],
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["background_job_id"], ["background_jobs.id"], ondelete="SET NULL"
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    for column in (
        "project_id",
        "publication_id",
        "document_id",
        "schema_version_id",
        "text_extraction_id",
        "status",
        "background_job_id",
    ):
        op.create_index(
            f"ix_llm_extraction_runs_{column}", "llm_extraction_runs", [column]
        )
    op.create_index(
        "ix_llm_runs_project_status", "llm_extraction_runs", ["project_id", "status"]
    )
    op.create_index(
        "ix_llm_runs_publication_created",
        "llm_extraction_runs",
        ["publication_id", "created_at"],
    )
    op.create_index(
        "uq_llm_active_run",
        "llm_extraction_runs",
        ["document_id", "schema_version_id"],
        unique=True,
        postgresql_where=sa.text("status IN ('pending', 'processing')"),
        sqlite_where=sa.text("status IN ('pending', 'processing')"),
    )

    op.create_table(
        "llm_field_suggestions",
        sa.Column("run_id", sa.String(36), nullable=False),
        sa.Column("schema_field_id", sa.String(36), nullable=False),
        sa.Column("mapped_extraction_field_key", sa.String(36)),
        sa.Column("value", json_type),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("evidence", json_type, nullable=False),
        sa.Column("evidence_validation_status", sa.String(20), nullable=False),
        *timestamps(),
        sa.ForeignKeyConstraint(
            ["run_id"], ["llm_extraction_runs.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["schema_field_id"], ["llm_schema_fields.id"], ondelete="RESTRICT"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("run_id", "schema_field_id", name="uq_llm_run_field"),
    )
    for column in ("run_id", "schema_field_id", "mapped_extraction_field_key"):
        op.create_index(
            f"ix_llm_field_suggestions_{column}", "llm_field_suggestions", [column]
        )

    op.create_table(
        "extraction_suggestion_reviews",
        sa.Column("extraction_response_id", sa.String(36), nullable=True),
        sa.Column("project_id", sa.String(36), nullable=False),
        sa.Column("publication_id", sa.String(36), nullable=False),
        sa.Column("reviewer_id", sa.String(36), nullable=True),
        sa.Column("response_version", sa.Integer(), nullable=False),
        sa.Column("extraction_field_key", sa.String(36), nullable=False),
        sa.Column("suggestion_id", sa.String(36)),
        sa.Column("reviewer_final_value", json_type),
        sa.Column("reviewer_final_value_hash", sa.String(64), nullable=False),
        sa.Column("disposition", sa.String(20), nullable=False),
        *timestamps(),
        sa.ForeignKeyConstraint(
            ["extraction_response_id"], ["extraction_responses.id"], ondelete="SET NULL"
        ),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["publication_id"], ["publications.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(["reviewer_id"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(
            ["suggestion_id"], ["llm_field_suggestions.id"], ondelete="SET NULL"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "extraction_response_id",
            "extraction_field_key",
            name="uq_extraction_suggestion_review",
        ),
    )
    for column in (
        "extraction_response_id",
        "project_id",
        "publication_id",
        "reviewer_id",
        "extraction_field_key",
        "suggestion_id",
    ):
        op.create_index(
            f"ix_extraction_suggestion_reviews_{column}",
            "extraction_suggestion_reviews",
            [column],
        )


def downgrade() -> None:
    op.drop_table("extraction_suggestion_reviews")
    op.drop_table("llm_field_suggestions")
    op.drop_table("llm_extraction_runs")
    op.drop_table("document_page_texts")
    op.drop_table("document_text_extractions")
    op.drop_table("llm_schema_fields")
    op.drop_table("llm_schema_versions")
    op.drop_table("project_llm_settings")
    op.drop_index("ix_background_jobs_priority", table_name="background_jobs")
    op.drop_column("background_jobs", "priority")
