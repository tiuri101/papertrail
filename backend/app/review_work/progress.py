"""Shared reviewer-progress queries for extraction and quality work-item
queues (see review_work/allocation.py for why screening is excluded).
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session


def remaining_claimable_items(
    db: Session,
    model: type[Any],
    *,
    project_id: str,
    reviewer_id: str,
    completed_status: Any,
) -> int:
    """How many work items this reviewer could still claim or complete in
    claim mode: their own incomplete items plus unclaimed ones."""
    return (
        db.scalar(
            select(func.count())
            .select_from(model)
            .where(
                model.project_id == project_id,
                model.status != completed_status,
                or_(
                    model.assigned_reviewer_id == reviewer_id,
                    model.assigned_reviewer_id.is_(None),
                ),
            )
        )
        or 0
    )


def reviewer_progress(
    db: Session,
    model: type[Any],
    *,
    project_id: str,
    reviewer_id: str,
    completed_status: Any,
    claim_mode: bool,
    remaining: int = 0,
) -> dict[str, int | bool]:
    """How many work items this reviewer has been assigned, and how many of
    those they've already completed. In claim mode, work items start
    unassigned, so `remaining` should be the caller's own
    remaining-claimable-items count (see remaining_claimable_items) --
    callers outside claim mode can omit it, since it's reported as 0 either
    way."""
    assigned = (
        db.scalar(
            select(func.count())
            .select_from(model)
            .where(
                model.project_id == project_id,
                model.assigned_reviewer_id == reviewer_id,
            )
        )
        or 0
    )
    completed = (
        db.scalar(
            select(func.count())
            .select_from(model)
            .where(
                model.project_id == project_id,
                model.assigned_reviewer_id == reviewer_id,
                model.status == completed_status,
            )
        )
        or 0
    )
    return {
        "assigned": assigned,
        "completed": completed,
        "remaining": remaining if claim_mode else 0,
        "claim_mode": claim_mode,
    }


def completed_items_with_response(
    db: Session,
    item_model: type[Any],
    response_model: type[Any],
    *,
    project_id: str,
    reviewer_id: str,
    completed_status: Any,
) -> list[tuple[Any, Any]]:
    """The reviewer's own completed work items, paired with their current
    response, so they can be revisited and corrected after submission."""
    items: list[Any] = list(
        db.scalars(
            select(item_model)
            .where(
                item_model.project_id == project_id,
                item_model.assigned_reviewer_id == reviewer_id,
                item_model.status == completed_status,
            )
            .order_by(item_model.completed_at.desc())
        )
    )
    pairs: list[tuple[Any, Any]] = []
    for item in items:
        response = db.scalar(
            select(response_model).where(
                response_model.work_item_id == item.id,
                response_model.is_current.is_(True),
            )
        )
        if response is not None:
            pairs.append((item, response))
    return pairs
