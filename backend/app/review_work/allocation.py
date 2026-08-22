"""Shared reviewer-allocation mechanics for extraction and quality work-item
queues.

Extraction and quality independently implemented the exact same
reassign/rebalance algorithms over their own work-item model and status
enum. Screening is deliberately NOT wired through this module: its queue has
real behavioral differences (dual-slot independent-decision reveal gate,
per-stage parameterization, LLM-ready ordering) that make sharing this
mechanic riskier than the value it would add here.

Domain services remain responsible for computing `eligible`/`claim_mode`
(whose exact defaulting behavior differs between extraction and quality) and
for any model-specific safety nets (e.g. extraction's distinct-slot check)
that must run around these calls.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session


def reassign_orphaned_items(
    db: Session,
    model: type[Any],
    *,
    project_id: str,
    eligible: list[str],
    claim_mode: bool,
    completed_status: Any,
    available_status: Any,
) -> int:
    """Redistribute not-yet-completed work items away from reviewers no
    longer eligible for this review stage, spreading them round-robin across
    whoever remains eligible (or releasing them to the open pool in claim
    mode). Completed items are always left untouched -- who actually did the
    work shouldn't change after the fact.
    """
    orphaned: list[Any] = list(
        db.scalars(
            select(model)
            .where(
                model.project_id == project_id,
                model.status != completed_status,
                model.assigned_reviewer_id.is_not(None),
                model.assigned_reviewer_id.not_in(eligible),
            )
            .order_by(model.random_rank)
        )
    )
    for index, item in enumerate(orphaned):
        item.assigned_reviewer_id = (
            None if claim_mode else eligible[index % len(eligible)]
        )
        item.status = available_status
        item.reserved_until = None
    db.flush()
    return len(orphaned)


def rebalance_pending_items(
    db: Session,
    model: type[Any],
    *,
    project_id: str,
    eligible: list[str],
    weights: dict[str, float],
    available_status: Any,
) -> int:
    """Spread not-yet-claimed (available) work items evenly across all
    currently eligible reviewers by weighted load, so someone just granted
    access picks up a fair share of the backlog. Reserved and completed
    items are left untouched.

    Callers are responsible for skipping this entirely in claim mode, where
    available items are an intentionally open pool for reviewers to pick
    from, not a backlog to pre-assign.
    """
    items: list[Any] = list(
        db.scalars(
            select(model)
            .where(model.project_id == project_id)
            .order_by(model.random_rank)
        )
    )
    load = {reviewer_id: 0 for reviewer_id in eligible}
    pending: list[Any] = []
    for item in items:
        if item.status == available_status:
            pending.append(item)
        elif item.assigned_reviewer_id in load:
            load[item.assigned_reviewer_id] += 1

    reassigned = 0
    for item in pending:
        chosen = min(eligible, key=lambda r: (load[r] / weights.get(r, 1.0), r))
        if item.assigned_reviewer_id != chosen:
            item.assigned_reviewer_id = chosen
            reassigned += 1
        load[chosen] += 1
    db.flush()
    return reassigned
