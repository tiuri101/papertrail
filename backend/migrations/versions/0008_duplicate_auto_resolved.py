"""add auto_resolved to duplicate_candidates

Exact-identifier duplicate pairs (matching DOI, PubMed ID, or arXiv ID --
the cases ``_duplicate_assessment`` already scores at 1.0 confidence) are now
merged automatically by ``detect_duplicates`` instead of waiting for a
reviewer, so the duplicate-review queue only holds pairs that actually need a
judgment call. Every automatic resolution still produces the same
``PublicationMerge`` audit trail a manual merge would (with ``merged_by_id``
left null), and the candidate keeps its row so it stays visible in the
resolved-duplicates list -- this column just lets the API and UI tell an
automatic merge apart from a reviewer's.

Revision ID: 0008_duplicate_auto_resolved
Revises: 0007_browser_manual_capture
Create Date: 2026-08-27
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0008_duplicate_auto_resolved"
down_revision: str | None = "0007_browser_manual_capture"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "duplicate_candidates",
        sa.Column(
            "auto_resolved", sa.Boolean(), server_default="false", nullable=False
        ),
    )


def downgrade() -> None:
    op.drop_column("duplicate_candidates", "auto_resolved")
