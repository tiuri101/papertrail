"""at most one valid final screening decision per publication and stage

``final_decisions`` keeps superseded verdicts as history by flipping
``is_valid`` to False rather than deleting them, so "the current authoritative
screening decision for this publication at this stage" is *the* valid row --
singular. Nothing enforced that: ``record_final_decision`` invalidates the
previous row and inserts the new one, but two transactions finalizing the
same publication concurrently could interleave between those two writes and
leave two valid rows behind, after which ``valid_final_decision`` silently
picks whichever sorts first.

This revision makes it a database rule, mirroring
``uq_final_extraction_current`` on ``final_extractions``. Serializing
finalization on the publication row (``app.review_work.finalization``) is what
keeps the invariant in normal operation; this index is the backstop.

Existing databases may already hold duplicates from before the lock existed,
so the upgrade resolves them first, without deleting anything: within each
duplicated ``(publication_id, stage)`` group it keeps the newest row (by
``created_at``, then ``id``, both deterministic) as the current verdict and
marks the rest invalidated with an explicit reason, exactly the shape a
normal supersession leaves behind. Screening history, reviewer decisions and
audit events are untouched.

Revision ID: 0004_final_decision_unique
Revises: 0003_import_source_row_unique
Create Date: 2026-08-25
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0004_final_decision_unique"
down_revision: str | None = "0003_import_source_row_unique"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

INDEX_NAME = "uq_final_decision_current"

_SUPERSEDE_DUPLICATES = sa.text(
    """
    UPDATE final_decisions
    SET is_valid = false,
        invalidated_at = COALESCE(invalidated_at, now()),
        invalidation_reason = COALESCE(
            invalidation_reason, 'Superseded: concurrent finalization left two valid rows'
        )
    WHERE id IN (
        SELECT id
        FROM (
            SELECT
                id,
                ROW_NUMBER() OVER (
                    PARTITION BY publication_id, stage
                    ORDER BY created_at DESC, id DESC
                ) AS recency_rank
            FROM final_decisions
            WHERE is_valid = true
        ) ranked
        WHERE ranked.recency_rank > 1
    )
    """
)


def upgrade() -> None:
    op.get_bind().execute(_SUPERSEDE_DUPLICATES)
    op.create_index(
        INDEX_NAME,
        "final_decisions",
        ["publication_id", "stage"],
        unique=True,
        postgresql_where=sa.text("is_valid = true"),
        sqlite_where=sa.text("is_valid = 1"),
    )


def downgrade() -> None:
    op.drop_index(INDEX_NAME, table_name="final_decisions")
