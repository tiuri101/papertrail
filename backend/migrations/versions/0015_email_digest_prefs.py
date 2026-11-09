"""debounced LLM completion emails and per-user email preferences

* `background_jobs.run_after` lets a job be scheduled for later, so the
  "LLM processing finished" check can wait for a quiet period instead of
  firing after every single run.
* `projects.llm_notified_through` records how far LLM results have already
  been reported, so one project-wide digest replaces one email per bulk. It
  is backfilled to the migration time: work that finished before this
  revision was already reported under the old per-bulk emails.
* `users.email_preferences` holds per-user opt-outs for optional email
  categories (see `app.notifications.preferences`).

Revision ID: 0015_email_digest_prefs
Revises: 0014_dedup_during_screening
Create Date: 2026-11-09
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0015_email_digest_prefs"
down_revision: str | None = "0014_dedup_during_screening"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "background_jobs",
        sa.Column("run_after", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index(
        "ix_background_jobs_run_after",
        "background_jobs",
        ["run_after"],
        unique=False,
    )
    op.add_column(
        "projects",
        sa.Column("llm_notified_through", sa.DateTime(timezone=True), nullable=True),
    )
    op.execute("UPDATE projects SET llm_notified_through = CURRENT_TIMESTAMP")
    op.add_column(
        "users",
        sa.Column(
            "email_preferences",
            sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), "postgresql"),
            nullable=False,
            server_default=sa.text("'{}'"),
        ),
    )
    # Backfill only; the app always supplies a value going forward.
    op.alter_column("users", "email_preferences", server_default=None)


def downgrade() -> None:
    op.drop_column("users", "email_preferences")
    op.drop_column("projects", "llm_notified_through")
    op.drop_index("ix_background_jobs_run_after", table_name="background_jobs")
    op.drop_column("background_jobs", "run_after")
