"""add browser_manual_capture to the documentsource enum

The browser extension gains a second way to attach a PDF: capturing whatever
is open in the current tab and attaching it directly to a publication the
reviewer picks (or an exact-DOI auto-match), rather than fetching a PDF for a
pre-assigned ``PdfRetrievalJob``. Both paths go through the same
``attach_staged_pdf`` write path and need to remain distinguishable in the
audit trail and in ``publication_documents.source``, so this adds a fourth
native enum value alongside ``MANUAL``/``BULK_IMPORT``/``BROWSER_RETRIEVAL``.

PostgreSQL cannot add an enum value inside the same transaction it will be
read back in, but nothing in this migration uses the new value -- it is only
made available for future writes -- so a plain ``ALTER TYPE ... ADD VALUE``
inside an autocommit block is sufficient. SQLite (used only for the ephemeral
pytest schema, built straight from ``Base.metadata`` rather than migrations)
picks up the new value automatically and needs no schema change here.

Revision ID: 0007_browser_manual_capture
Revises: 0006_project_single_owner
Create Date: 2026-08-26
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0007_browser_manual_capture"
down_revision: str | None = "0006_project_single_owner"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

NEW_VALUE = "BROWSER_MANUAL_CAPTURE"


def upgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        return
    with op.get_context().autocommit_block():
        op.execute(f"ALTER TYPE documentsource ADD VALUE IF NOT EXISTS '{NEW_VALUE}'")


def downgrade() -> None:
    # PostgreSQL has no "drop one enum value" operation short of rebuilding
    # the type; left as a no-op since an unused value is harmless and no row
    # can reference it unless application code writes it again.
    pass
