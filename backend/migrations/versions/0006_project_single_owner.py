"""exactly one owner per project

``project_memberships.is_owner`` was an ordinary boolean with no constraint
behind it, so the schema allowed a project to have two owners or none, while
everything that reads ownership assumes exactly one: the projects list renders
a single ``owner`` field, ``is_project_manager`` treats owner as the
project-level management role, and owner notifications fan out to whatever the
query happens to return.  Nothing but convention kept it single -- and removing
the sole owner's membership was accepted, leaving a project no one could
manage and no operation could give an owner back.

The application now owns the "at least one" half of the invariant (a project
is created with an owner, the owner cannot be removed, and ownership moves
only through the transactional Transfer Ownership operation).  This revision
adds the backstop for the "at most one" half, which application code cannot
guarantee against concurrent transactions.

Data safety: existing rows may already violate it, and the index would then
fail to build.  The upgrade resolves duplicates first, without deleting any
membership: within each project it keeps the *earliest* owner membership (by
``created_at``, then ``id``, both deterministic) -- the one the project was
created with -- and demotes the rest to ordinary members.  Their reviewer
eligibility, workload weight and every decision they made are untouched; they
simply stop being project managers, which is what a single-owner model means.
Projects with no owner at all are left alone: this revision cannot invent one,
and a partial unique index does not require a row to exist.  ``papertrail
projects`` (or the query below) will surface any such project for an
administrator to fix with Transfer Ownership.

The dev database checked before writing this revision held three projects,
each with exactly one owner, so the normalization is expected to be a no-op in
practice; it exists for databases written before ownership was enforced.

Revision ID: 0006_project_single_owner
Revises: 0005_quality_config_enums
Create Date: 2026-08-26
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0006_project_single_owner"
down_revision: str | None = "0005_quality_config_enums"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

INDEX_NAME = "uq_project_single_owner"

_DEMOTE_EXTRA_OWNERS = sa.text(
    """
    UPDATE project_memberships
    SET is_owner = false
    WHERE id IN (
        SELECT id
        FROM (
            SELECT
                id,
                ROW_NUMBER() OVER (
                    PARTITION BY project_id
                    ORDER BY created_at ASC, id ASC
                ) AS ownership_rank
            FROM project_memberships
            WHERE is_owner = true
        ) ranked
        WHERE ranked.ownership_rank > 1
    )
    """
)


def upgrade() -> None:
    op.get_bind().execute(_DEMOTE_EXTRA_OWNERS)
    op.create_index(
        INDEX_NAME,
        "project_memberships",
        ["project_id"],
        unique=True,
        postgresql_where=sa.text("is_owner = true"),
        sqlite_where=sa.text("is_owner = 1"),
    )


def downgrade() -> None:
    op.drop_index(INDEX_NAME, table_name="project_memberships")
