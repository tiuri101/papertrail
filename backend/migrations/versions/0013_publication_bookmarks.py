"""private per-user publication bookmarks

Adds `publication_bookmarks`, one row per (user, publication) a reviewer has
bookmarked. Bookmarks are a personal reading aid and never part of review
data; see `app.bookmarks.service` for how merged publications are resolved.

Revision ID: 0013_publication_bookmarks
Revises: 0012_user_ui_preferences
Create Date: 2026-11-02
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0013_publication_bookmarks"
down_revision: str | None = "0012_user_ui_preferences"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "publication_bookmarks",
        sa.Column("user_id", sa.String(length=36), nullable=False),
        sa.Column("project_id", sa.String(length=36), nullable=False),
        sa.Column("publication_id", sa.String(length=36), nullable=False),
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(
            ["project_id"],
            ["projects.id"],
            name=op.f("fk_publication_bookmarks_project_id_projects"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["publication_id"],
            ["publications.id"],
            name=op.f("fk_publication_bookmarks_publication_id_publications"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_publication_bookmarks_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_publication_bookmarks")),
        sa.UniqueConstraint(
            "user_id",
            "publication_id",
            name=op.f("uq_publication_bookmarks_user_id"),
        ),
    )
    op.create_index(
        op.f("ix_publication_bookmarks_project_id"),
        "publication_bookmarks",
        ["project_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_publication_bookmarks_publication_id"),
        "publication_bookmarks",
        ["publication_id"],
        unique=False,
    )
    op.create_index(
        "ix_publication_bookmarks_user_project",
        "publication_bookmarks",
        ["user_id", "project_id"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index(
        "ix_publication_bookmarks_user_project", table_name="publication_bookmarks"
    )
    op.drop_index(
        op.f("ix_publication_bookmarks_publication_id"),
        table_name="publication_bookmarks",
    )
    op.drop_index(
        op.f("ix_publication_bookmarks_project_id"),
        table_name="publication_bookmarks",
    )
    op.drop_table("publication_bookmarks")
