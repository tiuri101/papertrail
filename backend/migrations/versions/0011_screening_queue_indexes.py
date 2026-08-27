"""composite indexes for the screening reviewer queue

The screening "load next publication" and "submit decision" paths degrade
badly on projects with several thousand publications. The queries behind them
filter screening work items by (project, stage, status, assignee) and order by
random_rank, ask for the current decision of a work item, and (with LLM
assistance on) test whether a publication has a completed screening run. None
of those were covered by a composite index, so the planner combined
single-column indexes and sorted in memory over the whole stage.

Index-only change; no data migration.

Revision ID: 0011_screening_queue_indexes
Revises: 0010_duplicate_url_assessment
Create Date: 2026-08-27
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0011_screening_queue_indexes"
down_revision: str | None = "0010_duplicate_url_assessment"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_index(
        "ix_screening_wi_queue",
        "screening_work_items",
        ["project_id", "stage", "status", "assigned_reviewer_id", "random_rank"],
        unique=False,
    )
    op.create_index(
        "ix_screening_wi_rank",
        "screening_work_items",
        ["project_id", "stage", "random_rank"],
        unique=False,
    )
    op.create_index(
        "ix_screening_decision_current",
        "screening_decisions",
        ["work_item_id", "is_current"],
        unique=False,
    )
    op.create_index(
        "ix_llm_runs_pub_task_status",
        "llm_extraction_runs",
        ["publication_id", "task_type", "status"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index(
        "ix_llm_runs_pub_task_status", table_name="llm_extraction_runs"
    )
    op.drop_index(
        "ix_screening_decision_current", table_name="screening_decisions"
    )
    op.drop_index("ix_screening_wi_rank", table_name="screening_work_items")
    op.drop_index("ix_screening_wi_queue", table_name="screening_work_items")
