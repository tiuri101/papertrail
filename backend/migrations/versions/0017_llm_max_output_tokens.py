"""LLM output token cap

* `llm_installation_settings.max_output_tokens` caps how many tokens Ollama may
  generate per request (`num_predict`), so a model that loops on a document
  stops early instead of running into the request timeout. Existing rows get
  the default of 4096.

Revision ID: 0017_llm_max_output_tokens
Revises: 0016_project_archive
Create Date: 2026-11-10
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0017_llm_max_output_tokens"
down_revision: str | None = "0016_project_archive"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "llm_installation_settings",
        sa.Column(
            "max_output_tokens",
            sa.Integer(),
            server_default="4096",
            nullable=False,
        ),
    )
    # The default only backfills existing rows; the application always sets it.
    with op.batch_alter_table("llm_installation_settings") as batch:
        batch.alter_column("max_output_tokens", server_default=None)


def downgrade() -> None:
    op.drop_column("llm_installation_settings", "max_output_tokens")
