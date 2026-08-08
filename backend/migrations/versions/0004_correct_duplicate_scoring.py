"""correct duplicate candidate scoring

Revision ID: 0004_duplicate_scoring
Revises: 0003_llm_extraction
Create Date: 2026-08-08
"""

from collections.abc import Sequence

from alembic import op
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.deduplication.models import DuplicateCandidate
from app.deduplication.service import detect_duplicates

revision: str = "0004_duplicate_scoring"
down_revision: str | None = "0003_llm_extraction"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Re-evaluate stored unresolved candidates with the corrected rules."""
    session = Session(bind=op.get_bind())
    affected_projects = session.scalars(
        select(DuplicateCandidate.project_id)
        .where(DuplicateCandidate.status == "unresolved")
        .distinct()
    )
    for project_id in affected_projects:
        detect_duplicates(session, project_id)
    session.flush()


def downgrade() -> None:
    # Invalid candidates removed by this data correction cannot be reconstructed
    # reliably, and restoring known false positives would be harmful.
    pass
