"""add page count to publication documents

Revision ID: 0006_pdf_page_count
Revises: 0005_analysis_narrative_toggle
Create Date: 2026-08-16
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0006_pdf_page_count"
down_revision: str | None = "0005_analysis_narrative_toggle"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "publication_documents",
        sa.Column("page_count", sa.Integer(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("publication_documents", "page_count")
