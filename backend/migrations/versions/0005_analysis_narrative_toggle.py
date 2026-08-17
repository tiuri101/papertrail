"""add per-project toggle for LLM-generated Charts & Analysis narratives

Revision ID: 0005_analysis_narrative_toggle
Revises: 0004_browser_pdf_acquisition
Create Date: 2026-08-16
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0005_analysis_narrative_toggle"
down_revision: str | None = "0004_browser_pdf_acquisition"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "project_llm_settings",
        sa.Column(
            "analysis_narrative_enabled",
            sa.Boolean(),
            server_default="true",
            nullable=False,
        ),
    )


def downgrade() -> None:
    op.drop_column("project_llm_settings", "analysis_narrative_enabled")
