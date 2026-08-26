"""encrypted notification payload and throttle prune index

Adds the column that holds the authenticated-encryption envelope for the
credential-bearing part of a queued email (today: the password-reset link), so
that the notification queue no longer stores a usable reset token in clear
text, and the index that keeps the opportunistic login-throttle prune bounded.

Revision ID: 0002_encrypted_email_payload
Revises: 0001_initial_schema
Create Date: 2026-08-25
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0002_encrypted_email_payload"
down_revision: str | None = "0001_initial_schema"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "email_notifications",
        sa.Column("encrypted_context", sa.Text(), nullable=True),
    )
    op.create_index(
        op.f("ix_login_throttles_window_started_at"),
        "login_throttles",
        ["window_started_at"],
        unique=False,
    )
    # Every password-reset row written before this revision carries the raw
    # reset link in its plain-JSON context -- a live credential for as long as
    # the token has not expired, whether or not the email was already sent.
    # These rows are a delivery log, not workflow state, so drop them: an
    # affected user simply requests a new link, which is queued encrypted. A
    # still-queued send job for a deleted row fails with "Email notification
    # not found", which is the intended outcome.
    op.execute(
        sa.text("DELETE FROM email_notifications WHERE template = 'password_reset'")
    )


def downgrade() -> None:
    op.drop_index(
        op.f("ix_login_throttles_window_started_at"), table_name="login_throttles"
    )
    op.drop_column("email_notifications", "encrypted_context")
