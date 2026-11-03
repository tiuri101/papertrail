"""duplicate detection for records imported during screening

Adds `publications.duplicate_check_pending`, which holds a record imported
after duplicate review out of screening until it has been checked for
duplicates, and records on `publication_merges` the stage a merge happened in
plus the screening stages whose outcomes disagreed between the merged records.

Revision ID: 0014_dedup_during_screening
Revises: 0013_publication_bookmarks
Create Date: 2026-11-03
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0014_dedup_during_screening"
down_revision: str | None = "0013_publication_bookmarks"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "publications",
        sa.Column(
            "duplicate_check_pending",
            sa.Boolean(),
            server_default="false",
            nullable=False,
        ),
    )
    op.add_column(
        "publication_merges",
        sa.Column("stage_at_merge", sa.String(length=40), nullable=True),
    )
    op.add_column(
        "publication_merges",
        sa.Column(
            "outcome_conflict_stages",
            sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), "postgresql"),
            server_default=sa.text("'[]'"),
            nullable=False,
        ),
    )


def downgrade() -> None:
    op.drop_column("publication_merges", "outcome_conflict_stages")
    op.drop_column("publication_merges", "stage_at_merge")
    op.drop_column("publications", "duplicate_check_pending")
