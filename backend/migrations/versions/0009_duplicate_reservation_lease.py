"""add a reservation lease to duplicate_candidates

The duplicate-review stage now hands one unresolved candidate pair at a time
to a reviewer, the same way screening / extraction / quality do. A claimed
pair carries a short expiring lease (``reserved_by_id`` / ``reserved_until``)
so two reviewers working the queue concurrently are never given the same
pair. Both columns are nullable and start empty -- an existing unresolved
candidate is simply unreserved until someone claims it.

Revision ID: 0009_duplicate_reservation_lease
Revises: 0008_duplicate_auto_resolved
Create Date: 2026-08-27
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0009_duplicate_reservation_lease"
down_revision: str | None = "0008_duplicate_auto_resolved"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "duplicate_candidates",
        sa.Column("reserved_by_id", sa.String(length=36), nullable=True),
    )
    op.add_column(
        "duplicate_candidates",
        sa.Column("reserved_until", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_foreign_key(
        op.f("fk_duplicate_candidates_reserved_by_id_users"),
        "duplicate_candidates",
        "users",
        ["reserved_by_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index(
        op.f("ix_duplicate_candidates_reserved_until"),
        "duplicate_candidates",
        ["reserved_until"],
    )


def downgrade() -> None:
    op.drop_index(
        op.f("ix_duplicate_candidates_reserved_until"),
        table_name="duplicate_candidates",
    )
    op.drop_constraint(
        op.f("fk_duplicate_candidates_reserved_by_id_users"),
        "duplicate_candidates",
        type_="foreignkey",
    )
    op.drop_column("duplicate_candidates", "reserved_until")
    op.drop_column("duplicate_candidates", "reserved_by_id")
