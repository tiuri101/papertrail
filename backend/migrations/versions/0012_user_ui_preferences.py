"""per-user UI preferences (screening hotkeys, title/abstract fonts)

Adds an opaque, namespaced JSON blob on `users` so reviewer-editable display
preferences follow the reviewer across browsers/devices instead of living in
`localStorage`. The backend never interprets its contents beyond a size cap
(see `app.accounts.schemas.SelfUpdate.ui_preferences`).

Revision ID: 0012_user_ui_preferences
Revises: 0011_screening_queue_indexes
Create Date: 2026-08-28
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0012_user_ui_preferences"
down_revision: str | None = "0011_screening_queue_indexes"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column(
            "ui_preferences",
            sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), "postgresql"),
            nullable=False,
            server_default=sa.text("'{}'"),
        ),
    )
    # The server_default only exists to backfill existing rows; the app always
    # supplies a value going forward, matching the column-default pattern used
    # elsewhere in this schema.
    op.alter_column("users", "ui_preferences", server_default=None)


def downgrade() -> None:
    op.drop_column("users", "ui_preferences")
