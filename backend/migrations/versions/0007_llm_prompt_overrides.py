"""add administrator-managed base prompt overrides to LLM installation settings

Revision ID: 0007_llm_prompt_overrides
Revises: 0006_pdf_page_count
Create Date: 2026-08-17
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0007_llm_prompt_overrides"
down_revision: str | None = "0006_pdf_page_count"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "llm_installation_settings",
        sa.Column("title_abstract_base_prompt", sa.Text(), nullable=True),
    )
    op.add_column(
        "llm_installation_settings",
        sa.Column("full_text_base_prompt", sa.Text(), nullable=True),
    )
    op.add_column(
        "llm_installation_settings",
        sa.Column("extraction_base_prompt", sa.Text(), nullable=True),
    )
    op.add_column(
        "llm_installation_settings",
        sa.Column("validation_base_prompt", sa.Text(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("llm_installation_settings", "validation_base_prompt")
    op.drop_column("llm_installation_settings", "extraction_base_prompt")
    op.drop_column("llm_installation_settings", "full_text_base_prompt")
    op.drop_column("llm_installation_settings", "title_abstract_base_prompt")
