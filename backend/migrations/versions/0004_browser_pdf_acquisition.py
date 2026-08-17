"""add browser agent pairing/auth and client-side PDF retrieval batches/jobs

Revision ID: 0004_browser_pdf_acquisition
Revises: 0003_reviewer_allocation
Create Date: 2026-08-15
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0004_browser_pdf_acquisition"
down_revision: str | None = "0003_reviewer_allocation"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name == "postgresql":
        op.execute("ALTER TYPE documentsource ADD VALUE IF NOT EXISTS 'BROWSER_RETRIEVAL'")

    op.create_table(
        "browser_agents",
        sa.Column("user_id", sa.String(length=36), nullable=False),
        sa.Column("display_name", sa.String(length=200), nullable=False),
        sa.Column("token_hash", sa.String(length=64), nullable=False),
        sa.Column("extension_version", sa.String(length=50), nullable=True),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_browser_agents_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_browser_agents")),
        sa.UniqueConstraint("token_hash", name=op.f("uq_browser_agents_token_hash")),
    )
    op.create_index(
        op.f("ix_browser_agents_user_id"), "browser_agents", ["user_id"], unique=False
    )
    op.create_index(
        op.f("ix_browser_agents_token_hash"),
        "browser_agents",
        ["token_hash"],
        unique=False,
    )
    op.create_index(
        op.f("ix_browser_agents_revoked_at"),
        "browser_agents",
        ["revoked_at"],
        unique=False,
    )

    op.create_table(
        "browser_agent_pairings",
        sa.Column("user_id", sa.String(length=36), nullable=False),
        sa.Column("token_hash", sa.String(length=64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_browser_agent_pairings_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_browser_agent_pairings")),
        sa.UniqueConstraint(
            "token_hash", name=op.f("uq_browser_agent_pairings_token_hash")
        ),
    )
    op.create_index(
        op.f("ix_browser_agent_pairings_user_id"),
        "browser_agent_pairings",
        ["user_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_browser_agent_pairings_token_hash"),
        "browser_agent_pairings",
        ["token_hash"],
        unique=False,
    )
    op.create_index(
        op.f("ix_browser_agent_pairings_expires_at"),
        "browser_agent_pairings",
        ["expires_at"],
        unique=False,
    )

    op.create_table(
        "pdf_retrieval_batches",
        sa.Column("project_id", sa.String(length=36), nullable=False),
        sa.Column("created_by_user_id", sa.String(length=36), nullable=True),
        sa.Column(
            "status",
            sa.Enum("RUNNING", "COMPLETED", "CANCELLED", name="batchstatus"),
            nullable=False,
        ),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("cancelled_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(
            ["created_by_user_id"],
            ["users.id"],
            name=op.f("fk_pdf_retrieval_batches_created_by_user_id_users"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["project_id"],
            ["projects.id"],
            name=op.f("fk_pdf_retrieval_batches_project_id_projects"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_pdf_retrieval_batches")),
    )
    op.create_index(
        op.f("ix_pdf_retrieval_batches_project_id"),
        "pdf_retrieval_batches",
        ["project_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_pdf_retrieval_batches_status"),
        "pdf_retrieval_batches",
        ["status"],
        unique=False,
    )

    op.create_table(
        "pdf_retrieval_jobs",
        sa.Column("batch_id", sa.String(length=36), nullable=False),
        sa.Column("project_id", sa.String(length=36), nullable=False),
        sa.Column("publication_id", sa.String(length=36), nullable=False),
        sa.Column(
            "status",
            sa.Enum(
                "QUEUED",
                "CLAIMED",
                "RETRIEVING",
                "UPLOADING",
                "SUCCEEDED",
                "NEEDS_AUTHENTICATION",
                "NOT_FOUND",
                "ACCESS_DENIED",
                "INVALID_RESPONSE",
                "FAILED",
                "CANCELLED",
                "SKIPPED_EXISTING",
                name="retrievaljobstatus",
            ),
            nullable=False,
        ),
        sa.Column("claimed_by_agent_id", sa.String(length=36), nullable=True),
        sa.Column("claimed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("lease_until", sa.DateTime(timezone=True), nullable=True),
        sa.Column("attempt_count", sa.Integer(), nullable=False),
        sa.Column("resolved_landing_url", sa.String(length=2000), nullable=True),
        sa.Column("resolved_pdf_url", sa.String(length=2000), nullable=True),
        sa.Column("http_status", sa.Integer(), nullable=True),
        sa.Column("error_code", sa.String(length=50), nullable=True),
        sa.Column("error_message", sa.String(length=500), nullable=True),
        sa.Column("created_document_id", sa.String(length=36), nullable=True),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(
            ["batch_id"],
            ["pdf_retrieval_batches.id"],
            name=op.f("fk_pdf_retrieval_jobs_batch_id_pdf_retrieval_batches"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["claimed_by_agent_id"],
            ["browser_agents.id"],
            name=op.f("fk_pdf_retrieval_jobs_claimed_by_agent_id_browser_agents"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["created_document_id"],
            ["publication_documents.id"],
            name=op.f("fk_pdf_retrieval_jobs_created_document_id_publication_documents"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["project_id"],
            ["projects.id"],
            name=op.f("fk_pdf_retrieval_jobs_project_id_projects"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["publication_id"],
            ["publications.id"],
            name=op.f("fk_pdf_retrieval_jobs_publication_id_publications"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_pdf_retrieval_jobs")),
        sa.UniqueConstraint(
            "batch_id",
            "publication_id",
            name="uq_pdf_retrieval_job_batch_publication",
        ),
    )
    op.create_index(
        op.f("ix_pdf_retrieval_jobs_batch_id"),
        "pdf_retrieval_jobs",
        ["batch_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_pdf_retrieval_jobs_project_id"),
        "pdf_retrieval_jobs",
        ["project_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_pdf_retrieval_jobs_publication_id"),
        "pdf_retrieval_jobs",
        ["publication_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_pdf_retrieval_jobs_status"),
        "pdf_retrieval_jobs",
        ["status"],
        unique=False,
    )
    op.create_index(
        op.f("ix_pdf_retrieval_jobs_claimed_by_agent_id"),
        "pdf_retrieval_jobs",
        ["claimed_by_agent_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_pdf_retrieval_jobs_lease_until"),
        "pdf_retrieval_jobs",
        ["lease_until"],
        unique=False,
    )
    op.create_index(
        "ix_pdf_retrieval_jobs_status_lease",
        "pdf_retrieval_jobs",
        ["status", "lease_until"],
        unique=False,
    )
    op.create_index(
        "ix_pdf_retrieval_jobs_project_status",
        "pdf_retrieval_jobs",
        ["project_id", "status"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index(
        "ix_pdf_retrieval_jobs_project_status", table_name="pdf_retrieval_jobs"
    )
    op.drop_index("ix_pdf_retrieval_jobs_status_lease", table_name="pdf_retrieval_jobs")
    op.drop_index(
        op.f("ix_pdf_retrieval_jobs_lease_until"), table_name="pdf_retrieval_jobs"
    )
    op.drop_index(
        op.f("ix_pdf_retrieval_jobs_claimed_by_agent_id"),
        table_name="pdf_retrieval_jobs",
    )
    op.drop_index(op.f("ix_pdf_retrieval_jobs_status"), table_name="pdf_retrieval_jobs")
    op.drop_index(
        op.f("ix_pdf_retrieval_jobs_publication_id"), table_name="pdf_retrieval_jobs"
    )
    op.drop_index(
        op.f("ix_pdf_retrieval_jobs_project_id"), table_name="pdf_retrieval_jobs"
    )
    op.drop_index(op.f("ix_pdf_retrieval_jobs_batch_id"), table_name="pdf_retrieval_jobs")
    op.drop_table("pdf_retrieval_jobs")

    op.drop_index(
        op.f("ix_pdf_retrieval_batches_status"), table_name="pdf_retrieval_batches"
    )
    op.drop_index(
        op.f("ix_pdf_retrieval_batches_project_id"), table_name="pdf_retrieval_batches"
    )
    op.drop_table("pdf_retrieval_batches")

    op.drop_index(
        op.f("ix_browser_agent_pairings_expires_at"),
        table_name="browser_agent_pairings",
    )
    op.drop_index(
        op.f("ix_browser_agent_pairings_token_hash"),
        table_name="browser_agent_pairings",
    )
    op.drop_index(
        op.f("ix_browser_agent_pairings_user_id"), table_name="browser_agent_pairings"
    )
    op.drop_table("browser_agent_pairings")

    op.drop_index(op.f("ix_browser_agents_revoked_at"), table_name="browser_agents")
    op.drop_index(op.f("ix_browser_agents_token_hash"), table_name="browser_agents")
    op.drop_index(op.f("ix_browser_agents_user_id"), table_name="browser_agents")
    op.drop_table("browser_agents")

    bind = op.get_bind()
    if bind.dialect.name == "postgresql":
        op.execute("DROP TYPE IF EXISTS retrievaljobstatus")
        op.execute("DROP TYPE IF EXISTS batchstatus")
    # Postgres doesn't support removing a value from an enum type without
    # recreating it; the added 'BROWSER_RETRIEVAL' value on documentsource is
    # left in place on downgrade (same tradeoff as 0003's 'CLAIM' value).
