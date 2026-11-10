"""archivable projects

* `projects.archived_at` marks a project as archived: hidden from the default
  project overview but still listed under "Archived projects" and fully
  accessible. NULL for every existing project.

Revision ID: 0016_project_archive
Revises: 0015_email_digest_prefs
Create Date: 2026-11-10
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0016_project_archive"
down_revision: str | None = "0015_email_digest_prefs"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "projects",
        sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("projects", "archived_at")
