from __future__ import annotations

import hashlib
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import uuid4

from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import Session, joinedload, selectinload

from app.accounts.models import User
from app.api.errors import DomainError, ForbiddenError, NotFoundError
from app.projects.models import (
    Criterion,
    Project,
    ProjectMembership,
    ProjectStage,
    ScreeningConfig,
    ScreeningStage,
)
from app.publications.models import Publication
from app.screening.models import (
    ScreeningDecision,
    ScreeningOutcome,
    ScreeningWorkItem,
    WorkItemStatus,
)

RESERVATION_HOURS = 24


def utcnow() -> datetime:
    return datetime.now(UTC)


def rank_for(project: Project, publication_id: str, stage: ScreeningStage) -> str:
    value = f"{project.random_seed}:{project.id}:{publication_id}:{stage.value}"
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def eligible_reviewer_ids(
    db: Session, project_id: str, stage: ScreeningStage
) -> list[str]:
    membership_flag = (
        ProjectMembership.can_title_abstract_screen
        if stage == ScreeningStage.TITLE_ABSTRACT
        else ProjectMembership.can_full_text_screen
    )
    return list(
        db.scalars(
            select(User.id)
            .join(ProjectMembership, ProjectMembership.user_id == User.id)
            .where(
                ProjectMembership.project_id == project_id,
                membership_flag.is_(True),
                User.is_active.is_(True),
            )
            .order_by(User.username)
        )
    )


def get_screening_config(
    db: Session, project_id: str, stage: ScreeningStage
) -> ScreeningConfig | None:
    return db.scalar(
        select(ScreeningConfig).where(
            ScreeningConfig.project_id == project_id,
            ScreeningConfig.stage == stage,
        )
    )


def create_screening_work_items(
    db: Session,
    project: Project,
    stage: ScreeningStage,
    publication_ids: list[str] | None = None,
) -> int:
    config = get_screening_config(db, project.id, stage)
    if config is None:
        return 0
    reviewers = eligible_reviewer_ids(db, project.id, stage)
    if len(reviewers) < config.required_reviewers:
        raise DomainError(
            f"At least {config.required_reviewers} eligible reviewers are required "
            f"for {stage.value}"
        )
    query = select(Publication).where(
        Publication.project_id == project.id,
        Publication.is_active.is_(True),
        Publication.merged_into_id.is_(None),
    )
    if publication_ids is not None:
        query = query.where(Publication.id.in_(publication_ids))
    publications = list(db.scalars(query.order_by(Publication.id)))
    created = 0
    newly_eligible_publication_ids: set[str] = set()
    for publication_index, publication in enumerate(publications):
        rank = rank_for(project, publication.id, stage)
        for slot in range(config.required_reviewers):
            existing = db.scalar(
                select(ScreeningWorkItem.id).where(
                    ScreeningWorkItem.publication_id == publication.id,
                    ScreeningWorkItem.stage == stage,
                    ScreeningWorkItem.slot_number == slot + 1,
                )
            )
            if existing:
                continue
            reviewer_index = (
                publication_index * config.required_reviewers + slot
            ) % len(reviewers)
            db.add(
                ScreeningWorkItem(
                    project_id=project.id,
                    publication_id=publication.id,
                    stage=stage,
                    slot_number=slot + 1,
                    assigned_reviewer_id=reviewers[reviewer_index],
                    random_rank=rank,
                )
            )
            created += 1
            newly_eligible_publication_ids.add(publication.id)
    db.flush()
    if stage == ScreeningStage.TITLE_ABSTRACT:
        # Precompute suggestions as soon as publications enter screening. The
        # result endpoint still enforces the independent-decision reveal gate.
        # Queueing once per publication (rather than per reviewer slot) also
        # avoids duplicate inference when a project uses dual screening.
        from app.llm.task_service import queue_title_abstract_suggestion

        bulk_id = str(uuid4())
        for publication_id in newly_eligible_publication_ids:
            queue_title_abstract_suggestion(
                db, publication_id, priority=0, bulk_id=bulk_id
            )
    return created


def reassign_work_items_from_ineligible_reviewers(
    db: Session, project_id: str, stage: ScreeningStage
) -> int:
    """Redistribute a stage's not-yet-submitted work items away from reviewers who
    are no longer eligible for it (removed from the project, or had the stage
    permission turned off), spreading them round-robin across whoever is
    currently eligible.

    Assignment happens once, at creation time, so nothing else revisits it -- if a
    reviewer is removed afterward, their existing AVAILABLE/RESERVED items would
    otherwise sit assigned to someone who can no longer claim them, invisible to
    every other reviewer too, since each reviewer's queue only ever looks at items
    assigned to them specifically. Submitted items are left untouched: who actually
    screened a publication shouldn't change after the fact.
    """
    eligible = eligible_reviewer_ids(db, project_id, stage)
    if not eligible:
        return 0
    orphaned = list(
        db.scalars(
            select(ScreeningWorkItem)
            .where(
                ScreeningWorkItem.project_id == project_id,
                ScreeningWorkItem.stage == stage,
                ScreeningWorkItem.status != WorkItemStatus.SUBMITTED,
                ScreeningWorkItem.assigned_reviewer_id.is_not(None),
                ScreeningWorkItem.assigned_reviewer_id.not_in(eligible),
            )
            .order_by(ScreeningWorkItem.random_rank)
        )
    )
    for index, item in enumerate(orphaned):
        item.assigned_reviewer_id = eligible[index % len(eligible)]
        if item.status == WorkItemStatus.RESERVED:
            item.status = WorkItemStatus.AVAILABLE
            item.reserved_by_id = None
            item.reserved_until = None
    db.flush()
    return len(orphaned)


def reassign_work_item(
    db: Session, item: ScreeningWorkItem, reviewer_id: str
) -> ScreeningWorkItem:
    """Manually move a not-yet-submitted work item to a different reviewer.

    Restricted to reviewers currently eligible for this stage in this project --
    the same pool `create_screening_work_items` draws from -- so an admin can't
    hand a publication to someone outside the project by mistake.
    """
    if item.status == WorkItemStatus.SUBMITTED:
        raise DomainError(
            "A submitted work item can't be reassigned; its decision is already recorded"
        )
    eligible = eligible_reviewer_ids(db, item.project_id, item.stage)
    if reviewer_id not in eligible:
        raise DomainError("That reviewer isn't eligible for this stage on this project")
    item.assigned_reviewer_id = reviewer_id
    item.status = WorkItemStatus.AVAILABLE
    item.reserved_by_id = None
    item.reserved_until = None
    db.flush()
    return item


def bulk_reassign_work_items(
    db: Session, items: list[ScreeningWorkItem], reviewer_id: str
) -> int:
    """Reassign a validated collection with a single eligibility lookup."""
    if not items:
        return 0
    project_id = items[0].project_id
    stage = items[0].stage
    if any(item.project_id != project_id or item.stage != stage for item in items):
        raise DomainError("Bulk reassignment must contain one project and stage")
    if any(item.status == WorkItemStatus.SUBMITTED for item in items):
        raise DomainError("Submitted work items can't be reassigned")
    if reviewer_id not in eligible_reviewer_ids(db, project_id, stage):
        raise DomainError("That reviewer isn't eligible for this stage on this project")

    for item in items:
        item.assigned_reviewer_id = reviewer_id
        item.status = WorkItemStatus.AVAILABLE
        item.reserved_by_id = None
        item.reserved_until = None
    db.flush()
    return len(items)


def claim_next_work_item(
    db: Session,
    project_id: str,
    stage: ScreeningStage,
    reviewer_id: str,
    publication_id: str | None = None,
) -> ScreeningWorkItem | None:
    now = utcnow()
    # A page reload or interrupted browser session can leave the current item
    # reserved. Resume that item before looking for new work so it does not
    # disappear from the reviewer queue or accumulate as a hidden reservation.
    reserved_filters = [
        ScreeningWorkItem.project_id == project_id,
        ScreeningWorkItem.stage == stage,
        ScreeningWorkItem.assigned_reviewer_id == reviewer_id,
        ScreeningWorkItem.status == WorkItemStatus.RESERVED,
        ScreeningWorkItem.reserved_by_id == reviewer_id,
    ]
    if publication_id is not None:
        reserved_filters.append(ScreeningWorkItem.publication_id == publication_id)
    reserved_query = (
        select(ScreeningWorkItem)
        .where(*reserved_filters)
        .order_by(ScreeningWorkItem.random_rank, ScreeningWorkItem.slot_number)
        .limit(1)
    )
    if db.bind is not None and db.bind.dialect.name == "postgresql":
        reserved_query = reserved_query.with_for_update(skip_locked=True)
    reserved = db.scalar(reserved_query)
    if reserved is not None:
        reserved.reserved_until = now + timedelta(hours=RESERVATION_HOURS)
        db.flush()
        return reserved

    already_for_publication = select(ScreeningWorkItem.publication_id).where(
        ScreeningWorkItem.project_id == project_id,
        ScreeningWorkItem.stage == stage,
        or_(
            ScreeningWorkItem.assigned_reviewer_id == reviewer_id,
            ScreeningWorkItem.reserved_by_id == reviewer_id,
        ),
        ScreeningWorkItem.status.in_(
            [WorkItemStatus.RESERVED, WorkItemStatus.SUBMITTED]
        ),
    )
    filters = [
        ScreeningWorkItem.project_id == project_id,
        ScreeningWorkItem.stage == stage,
        ScreeningWorkItem.assigned_reviewer_id == reviewer_id,
        ScreeningWorkItem.status != WorkItemStatus.SUBMITTED,
        or_(
            ScreeningWorkItem.status == WorkItemStatus.AVAILABLE,
            and_(
                ScreeningWorkItem.status == WorkItemStatus.RESERVED,
                ScreeningWorkItem.reserved_until < now,
            ),
            ScreeningWorkItem.reserved_by_id == reviewer_id,
        ),
        ~ScreeningWorkItem.publication_id.in_(already_for_publication),
    ]
    if publication_id is not None:
        filters.append(ScreeningWorkItem.publication_id == publication_id)
    query = (
        select(ScreeningWorkItem)
        .where(*filters)
        .order_by(ScreeningWorkItem.random_rank, ScreeningWorkItem.slot_number)
        .limit(1)
    )
    if db.bind is not None and db.bind.dialect.name == "postgresql":
        query = query.with_for_update(skip_locked=True)
    item = db.scalar(query)
    if item is None:
        return None
    item.status = WorkItemStatus.RESERVED
    item.reserved_by_id = reviewer_id
    item.reserved_until = now + timedelta(hours=RESERVATION_HOURS)
    db.flush()
    return item


def release_work_item(item: ScreeningWorkItem, reviewer_id: str) -> None:
    if item.reserved_by_id != reviewer_id:
        raise ForbiddenError("This work item is not reserved by the current reviewer")
    item.status = WorkItemStatus.AVAILABLE
    item.reserved_by_id = None
    item.reserved_until = None


def save_draft(
    item: ScreeningWorkItem, reviewer_id: str, draft: dict[str, Any]
) -> None:
    if item.reserved_by_id != reviewer_id or item.status == WorkItemStatus.SUBMITTED:
        raise ForbiddenError("This work item cannot be edited")
    item.draft = draft


def required_criterion_ids(db: Session, project_id: str) -> set[str]:
    return set(
        db.scalars(
            select(Criterion.id).where(
                Criterion.project_id == project_id, Criterion.is_active.is_(True)
            )
        )
    )


def submit_decision(
    db: Session,
    item: ScreeningWorkItem,
    reviewer_id: str,
    outcome: str | ScreeningOutcome,
    criteria_answers: dict[str, bool],
    notes: str | None,
) -> ScreeningDecision:
    if item.assigned_reviewer_id != reviewer_id:
        raise ForbiddenError("This work item is assigned to another reviewer")
    required = required_criterion_ids(db, item.project_id)
    if set(criteria_answers) != required or any(
        not isinstance(value, bool) for value in criteria_answers.values()
    ):
        raise DomainError(
            "Every active inclusion and exclusion criterion must be explicitly answered"
        )
    parsed_outcome = ScreeningOutcome(outcome)
    current = db.scalar(
        select(ScreeningDecision).where(
            ScreeningDecision.work_item_id == item.id,
            ScreeningDecision.is_current.is_(True),
        )
    )
    version = 1
    if current:
        current.is_current = False
        version = current.version + 1
    decision = ScreeningDecision(
        work_item_id=item.id,
        reviewer_id=reviewer_id,
        outcome=parsed_outcome,
        criteria_answers=criteria_answers,
        notes=notes,
        version=version,
        is_current=True,
    )
    db.add(decision)
    if current is not None:
        from app.conflicts.service import invalidate_final_decisions

        invalidate_final_decisions(db, item.publication_id, item.stage)
    item.status = WorkItemStatus.SUBMITTED
    item.reserved_by_id = reviewer_id
    item.reserved_until = None
    item.submitted_at = utcnow()
    item.draft = {}
    db.flush()
    return decision


def decisions_visible(db: Session, publication_id: str, stage: ScreeningStage) -> bool:
    publication = db.get(Publication, publication_id)
    if publication is None:
        raise NotFoundError("Publication not found")
    config = get_screening_config(db, publication.project_id, stage)
    if config is None:
        return False
    count = (
        db.scalar(
            select(func.count())
            .select_from(ScreeningDecision)
            .join(ScreeningWorkItem)
            .where(
                ScreeningWorkItem.publication_id == publication_id,
                ScreeningWorkItem.stage == stage,
                ScreeningDecision.is_current.is_(True),
            )
        )
        or 0
    )
    return count >= config.required_reviewers


def current_decisions(
    db: Session, publication_id: str, stage: ScreeningStage
) -> list[ScreeningDecision]:
    if not decisions_visible(db, publication_id, stage):
        return []
    return list(
        db.scalars(
            select(ScreeningDecision)
            .join(ScreeningWorkItem)
            .options(joinedload(ScreeningDecision.reviewer))
            .where(
                ScreeningWorkItem.publication_id == publication_id,
                ScreeningWorkItem.stage == stage,
                ScreeningDecision.is_current.is_(True),
            )
            .order_by(ScreeningWorkItem.slot_number)
        )
    )


_PROJECT_STAGE_ORDER = [
    ProjectStage.DRAFT,
    ProjectStage.DUPLICATE_REVIEW,
    ProjectStage.TITLE_ABSTRACT,
    ProjectStage.FULL_TEXT,
    ProjectStage.EXTRACTION,
    ProjectStage.COMPLETED,
]

_PROJECT_STAGE_FOR_SCREENING_STAGE = {
    ScreeningStage.TITLE_ABSTRACT: ProjectStage.TITLE_ABSTRACT,
    ScreeningStage.FULL_TEXT: ProjectStage.FULL_TEXT,
}


def stage_completed(project: Project, stage: ScreeningStage) -> bool:
    """Whether the project has already moved past the given screening stage."""
    reached = _PROJECT_STAGE_FOR_SCREENING_STAGE[stage]
    return _PROJECT_STAGE_ORDER.index(project.stage) > _PROJECT_STAGE_ORDER.index(
        reached
    )


def my_progress(
    db: Session, project_id: str, stage: ScreeningStage, reviewer_id: str
) -> dict[str, int]:
    """How many work items this reviewer has been assigned for a stage, and how
    many of those they've already submitted a decision for."""
    assigned = (
        db.scalar(
            select(func.count())
            .select_from(ScreeningWorkItem)
            .where(
                ScreeningWorkItem.project_id == project_id,
                ScreeningWorkItem.stage == stage,
                ScreeningWorkItem.assigned_reviewer_id == reviewer_id,
            )
        )
        or 0
    )
    completed = (
        db.scalar(
            select(func.count())
            .select_from(ScreeningWorkItem)
            .where(
                ScreeningWorkItem.project_id == project_id,
                ScreeningWorkItem.stage == stage,
                ScreeningWorkItem.assigned_reviewer_id == reviewer_id,
                ScreeningWorkItem.status == WorkItemStatus.SUBMITTED,
            )
        )
        or 0
    )
    return {"assigned": assigned, "completed": completed}


def my_submitted_work_items(
    db: Session, project_id: str, stage: ScreeningStage, reviewer_id: str
) -> list[ScreeningWorkItem]:
    """A reviewer's own submitted work items for a stage, most recent first."""
    return list(
        db.scalars(
            select(ScreeningWorkItem)
            .options(selectinload(ScreeningWorkItem.decisions))
            .where(
                ScreeningWorkItem.project_id == project_id,
                ScreeningWorkItem.stage == stage,
                ScreeningWorkItem.assigned_reviewer_id == reviewer_id,
                ScreeningWorkItem.status == WorkItemStatus.SUBMITTED,
            )
            .order_by(ScreeningWorkItem.submitted_at.desc())
        )
    )
