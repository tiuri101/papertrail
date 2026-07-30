from __future__ import annotations

import hashlib
from datetime import UTC, datetime, timedelta

from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import Session, joinedload

from app.accounts.models import User
from app.api.errors import DomainError, ForbiddenError, NotFoundError
from app.projects.models import (
    Criterion,
    ExclusionReason,
    Project,
    ProjectMembership,
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
    member_ids = list(
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
    admin_ids = list(
        db.scalars(
            select(User.id)
            .where(User.is_admin.is_(True), User.is_active.is_(True))
            .order_by(User.username)
        )
    )
    return list(dict.fromkeys(member_ids + admin_ids))


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
    db.flush()
    return created


def claim_next_work_item(
    db: Session,
    project_id: str,
    stage: ScreeningStage,
    reviewer_id: str,
) -> ScreeningWorkItem | None:
    now = utcnow()
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
    query = (
        select(ScreeningWorkItem)
        .where(
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
        )
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


def save_draft(item: ScreeningWorkItem, reviewer_id: str, draft: dict) -> None:
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
    exclusion_reason_id: str | None,
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
    exclusion_reason_text = None
    if parsed_outcome == ScreeningOutcome.EXCLUDE:
        if exclusion_reason_id:
            reason = db.get(ExclusionReason, exclusion_reason_id)
            if (
                reason is None
                or reason.project_id != item.project_id
                or reason.stage != item.stage
                or not reason.is_active
            ):
                raise DomainError(
                    "The selected exclusion reason is not valid for this stage"
                )
            exclusion_reason_text = reason.label
        elif item.stage == ScreeningStage.FULL_TEXT:
            raise DomainError("An exclusion reason is required")
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
        exclusion_reason_id=exclusion_reason_id,
        exclusion_reason_text=exclusion_reason_text,
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
