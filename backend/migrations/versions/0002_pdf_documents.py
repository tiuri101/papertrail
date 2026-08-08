"""add PDF documents and import matching

Revision ID: 0002_pdf_documents
Revises: 0001_initial_schema
Create Date: 2026-08-08
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0002_pdf_documents"
down_revision: str | None = "0001_initial_schema"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

json_type = sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), "postgresql")


def upgrade() -> None:
    op.add_column(
        "publication_merges",
        sa.Column(
            "moved_document_states",
            json_type,
            server_default=sa.text("'[]'"),
            nullable=False,
        ),
    )
    op.create_table(
        "publication_documents",
        sa.Column("project_id", sa.String(length=36), nullable=False),
        sa.Column("publication_id", sa.String(length=36), nullable=False),
        sa.Column("original_filename", sa.String(length=500), nullable=False),
        sa.Column("storage_key", sa.String(length=1000), nullable=False),
        sa.Column("mime_type", sa.String(length=100), nullable=False),
        sa.Column("file_size", sa.BigInteger(), nullable=False),
        sa.Column("sha256", sa.String(length=64), nullable=False),
        sa.Column("uploaded_by_user_id", sa.String(length=36), nullable=True),
        sa.Column("uploaded_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False),
        sa.Column("replaced_by_document_id", sa.String(length=36), nullable=True),
        sa.Column("removed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("removed_by_user_id", sa.String(length=36), nullable=True),
        sa.Column(
            "source",
            sa.Enum("MANUAL", "BULK_IMPORT", name="documentsource"),
            nullable=False,
        ),
        sa.Column("import_batch_id", sa.String(length=36), nullable=True),
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["publication_id"], ["publications.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["uploaded_by_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["removed_by_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(
            ["replaced_by_document_id"],
            ["publication_documents.id"],
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(["import_batch_id"], ["import_batches.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("storage_key"),
    )
    op.create_index(
        "uq_publication_documents_active_primary",
        "publication_documents",
        ["publication_id"],
        unique=True,
        postgresql_where=sa.text("is_active = true"),
        sqlite_where=sa.text("is_active = 1"),
    )
    op.create_index(
        "ix_publication_documents_project_hash",
        "publication_documents",
        ["project_id", "sha256"],
    )
    for column in ("project_id", "publication_id", "uploaded_by_user_id", "import_batch_id"):
        op.create_index(f"ix_publication_documents_{column}", "publication_documents", [column])

    op.create_table(
        "import_pdf_items",
        sa.Column("import_batch_id", sa.String(length=36), nullable=False),
        sa.Column("project_id", sa.String(length=36), nullable=False),
        sa.Column("original_filename", sa.String(length=500), nullable=False),
        sa.Column("storage_key", sa.String(length=1000), nullable=True),
        sa.Column("mime_type", sa.String(length=100), nullable=True),
        sa.Column("file_size", sa.BigInteger(), nullable=True),
        sa.Column("sha256", sa.String(length=64), nullable=True),
        sa.Column("detected_doi", sa.String(length=300), nullable=True),
        sa.Column("detected_title", sa.Text(), nullable=True),
        sa.Column("detected_authors", sa.Text(), nullable=True),
        sa.Column("detected_year", sa.Integer(), nullable=True),
        sa.Column(
            "status",
            sa.Enum(
                "PENDING",
                "MATCHED",
                "AMBIGUOUS",
                "UNMATCHED",
                "DUPLICATE",
                "CONFLICT_EXISTING_PDF",
                "INVALID",
                "SKIPPED",
                name="pdfmatchstatus",
            ),
            nullable=False,
        ),
        sa.Column("candidate_matches", json_type, nullable=False),
        sa.Column("matched_publication_id", sa.String(length=36), nullable=True),
        sa.Column("attached_document_id", sa.String(length=36), nullable=True),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("resolved_by_id", sa.String(length=36), nullable=True),
        sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["import_batch_id"], ["import_batches.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["matched_publication_id"], ["publications.id"], ondelete="SET NULL"
        ),
        sa.ForeignKeyConstraint(
            ["attached_document_id"], ["publication_documents.id"], ondelete="SET NULL"
        ),
        sa.ForeignKeyConstraint(["resolved_by_id"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("storage_key"),
    )
    for column in (
        "import_batch_id",
        "project_id",
        "sha256",
        "detected_doi",
        "status",
        "matched_publication_id",
        "attached_document_id",
    ):
        op.create_index(f"ix_import_pdf_items_{column}", "import_pdf_items", [column])


def downgrade() -> None:
    op.drop_table("import_pdf_items")
    op.drop_table("publication_documents")
    op.drop_column("publication_merges", "moved_document_states")
    if op.get_bind().dialect.name == "postgresql":
        sa.Enum(name="pdfmatchstatus").drop(op.get_bind(), checkfirst=True)
        sa.Enum(name="documentsource").drop(op.get_bind(), checkfirst=True)
