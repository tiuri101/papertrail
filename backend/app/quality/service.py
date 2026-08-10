from __future__ import annotations

import hashlib
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.accounts.models import User
from app.api.errors import DomainError, ForbiddenError, NotFoundError
from app.conflicts.models import FinalDecision
from app.extraction.service import validate_answers
from app.forms.models import FieldType, FormField, FormKind, ReviewForm
from app.projects.models import Project, ProjectMembership, ScreeningStage
from app.quality.models import (
    QualityConfig,
    QualityResponse,
    QualityStatus,
    QualityWorkItem,
)
from app.screening.models import ScreeningOutcome


def utcnow() -> datetime:
    return datetime.now(UTC)


def quality_config(db: Session, project_id: str) -> QualityConfig | None:
    return db.scalar(
        select(QualityConfig).where(QualityConfig.project_id == project_id)
    )


def quality_form(db: Session, project_id: str) -> ReviewForm | None:
    return db.scalar(
        select(ReviewForm).where(
            ReviewForm.project_id == project_id, ReviewForm.kind == FormKind.QUALITY
        )
    )


def eligible_assessors(db: Session, project_id: str) -> list[str]:
    members = list(
        db.scalars(
            select(User.id)
            .join(ProjectMembership, ProjectMembership.user_id == User.id)
            .where(
                ProjectMembership.project_id == project_id,
                ProjectMembership.can_assess_quality.is_(True),
                User.is_active.is_(True),
            )
            .order_by(User.username)
        )
    )
    admins = list(
        db.scalars(
            select(User.id)
            .where(User.is_admin.is_(True), User.is_active.is_(True))
            .order_by(User.username)
        )
    )
    return list(dict.fromkeys(members + admins))


def included_publication_ids(db: Session, project_id: str) -> list[str]:
    return list(
        db.scalars(
            select(FinalDecision.publication_id).where(
                FinalDecision.project_id == project_id,
                FinalDecision.stage == ScreeningStage.FULL_TEXT,
                FinalDecision.outcome == ScreeningOutcome.INCLUDE,
                FinalDecision.is_valid.is_(True),
            )
        )
    )


def initialize_quality(db: Session, project: Project) -> int:
    config = quality_config(db, project.id)
    if config is None or not config.enabled:
        return 0
    if quality_form(db, project.id) is None:
        raise DomainError("Quality assessment is enabled but no quality form exists")
    reviewers = eligible_assessors(db, project.id)
    if not reviewers:
        raise DomainError("At least one eligible quality assessor is required")
    created = 0
    for index, publication_id in enumerate(
        sorted(included_publication_ids(db, project.id))
    ):
        if db.scalar(
            select(QualityWorkItem.id).where(
                QualityWorkItem.publication_id == publication_id
            )
        ):
            continue
        rank = hashlib.sha256(
            f"{project.random_seed}:{project.id}:{publication_id}:quality".encode()
        ).hexdigest()
        db.add(
            QualityWorkItem(
                project_id=project.id,
                publication_id=publication_id,
                assigned_reviewer_id=reviewers[index % len(reviewers)],
                random_rank=rank,
            )
        )
        created += 1
    db.flush()
    return created


def reassign_work_items_from_ineligible_reviewers(db: Session, project_id: str) -> int:
    """Redistribute not-yet-completed quality work items away from reviewers who are
    no longer eligible to assess quality (removed from the project, or had the
    quality-assessment permission turned off), spreading them round-robin across
    whoever is currently eligible.

    Mirrors screening's function of the same name: assignment happens once, at
    creation time, so nothing else revisits it -- if a reviewer's eligibility is
    revoked afterward, their existing AVAILABLE/RESERVED items would otherwise sit
    assigned to someone who can no longer claim them. Completed items are left
    untouched: who actually assessed a publication shouldn't change after the fact.
    """
    eligible = eligible_assessors(db, project_id)
    if not eligible:
        return 0
    orphaned = list(
        db.scalars(
            select(QualityWorkItem)
            .where(
                QualityWorkItem.project_id == project_id,
                QualityWorkItem.status != QualityStatus.COMPLETED,
                QualityWorkItem.assigned_reviewer_id.not_in(eligible),
            )
            .order_by(QualityWorkItem.random_rank)
        )
    )
    for index, item in enumerate(orphaned):
        item.assigned_reviewer_id = eligible[index % len(eligible)]
        item.status = QualityStatus.AVAILABLE
        item.reserved_until = None
    db.flush()
    return len(orphaned)


def rebalance_pending_work_items(db: Session, project_id: str) -> int:
    """Spread not-yet-claimed (AVAILABLE) quality work items evenly across all
    currently eligible assessors, so someone just granted access picks up a fair
    share of the backlog. Reserved and completed items are left untouched.
    """
    eligible = eligible_assessors(db, project_id)
    if not eligible:
        return 0
    items = list(
        db.scalars(
            select(QualityWorkItem)
            .where(QualityWorkItem.project_id == project_id)
            .order_by(QualityWorkItem.random_rank)
        )
    )
    load = {reviewer_id: 0 for reviewer_id in eligible}
    pending: list[QualityWorkItem] = []
    for item in items:
        if item.status == QualityStatus.AVAILABLE:
            pending.append(item)
        elif item.assigned_reviewer_id in load:
            load[item.assigned_reviewer_id] += 1

    reassigned = 0
    for item in pending:
        chosen = min(eligible, key=lambda r: (load[r], r))
        if item.assigned_reviewer_id != chosen:
            item.assigned_reviewer_id = chosen
            reassigned += 1
        load[chosen] += 1
    db.flush()
    return reassigned


def my_progress(db: Session, project_id: str, reviewer_id: str) -> dict[str, int]:
    """How many quality-assessment work items this reviewer has been assigned,
    and how many of those they've already completed."""
    assigned = (
        db.scalar(
            select(func.count())
            .select_from(QualityWorkItem)
            .where(
                QualityWorkItem.project_id == project_id,
                QualityWorkItem.assigned_reviewer_id == reviewer_id,
            )
        )
        or 0
    )
    completed = (
        db.scalar(
            select(func.count())
            .select_from(QualityWorkItem)
            .where(
                QualityWorkItem.project_id == project_id,
                QualityWorkItem.assigned_reviewer_id == reviewer_id,
                QualityWorkItem.status == QualityStatus.COMPLETED,
            )
        )
        or 0
    )
    return {"assigned": assigned, "completed": completed}


def claim_next_quality(
    db: Session,
    project_id: str,
    reviewer_id: str,
    excluded_item_ids: set[str] | None = None,
) -> QualityWorkItem | None:
    now = utcnow()
    query = (
        select(QualityWorkItem)
        .where(
            QualityWorkItem.project_id == project_id,
            QualityWorkItem.assigned_reviewer_id == reviewer_id,
            QualityWorkItem.status != QualityStatus.COMPLETED,
            (
                (QualityWorkItem.status == QualityStatus.AVAILABLE)
                | (QualityWorkItem.reserved_until < now)
            ),
        )
        .order_by(QualityWorkItem.random_rank)
        .limit(1)
    )
    if excluded_item_ids:
        query = query.where(QualityWorkItem.id.not_in(excluded_item_ids))
    if db.bind is not None and db.bind.dialect.name == "postgresql":
        query = query.with_for_update(skip_locked=True)
    item = db.scalar(query)
    if item:
        item.status = QualityStatus.RESERVED
        item.reserved_until = now + timedelta(days=1)
        db.flush()
    return item


def save_draft(item: QualityWorkItem, reviewer_id: str, draft: dict[str, Any]) -> None:
    if (
        item.assigned_reviewer_id != reviewer_id
        or item.status == QualityStatus.COMPLETED
    ):
        raise ForbiddenError("This quality-assessment work item cannot be edited")
    item.draft = draft


def active_fields(db: Session, form: ReviewForm) -> list[FormField]:
    return list(
        db.scalars(
            select(FormField)
            .where(
                FormField.form_version_id == form.active_version_id,
                FormField.is_archived.is_(False),
            )
            .order_by(FormField.position)
        )
    )


def score_response(
    fields: list[FormField], answers: dict[str, Any], aggregation: str
) -> float | None:
    weighted_values: list[tuple[float, float]] = []
    for field in fields:
        value = answers.get(field.stable_key)
        if value is None:
            continue
        scoring = field.scoring or {}
        weight = float(scoring.get("weight", 1))
        score: float | None = None
        if field.field_type in {FieldType.NUMBER, FieldType.RATING} and isinstance(
            value, (int, float)
        ):
            score = float(value)
        elif field.field_type == FieldType.SINGLE_SELECT:
            mapped = scoring.get("values", {}).get(str(value))
            if mapped is not None:
                score = float(mapped)
        elif field.field_type == FieldType.CHECKBOX:
            mapped = scoring.get("true" if value else "false")
            if mapped is not None:
                score = float(mapped)
        if score is not None:
            weighted_values.append((score, weight))
    if not weighted_values:
        return None
    total = sum(score * weight for score, weight in weighted_values)
    if aggregation == "weighted_average":
        denominator = sum(weight for _, weight in weighted_values)
        return total / denominator if denominator else None
    if aggregation == "average":
        return sum(score for score, _ in weighted_values) / len(weighted_values)
    return total


def submit_quality(
    db: Session, item: QualityWorkItem, reviewer_id: str, answers: dict[str, Any]
) -> QualityResponse:
    if item.assigned_reviewer_id != reviewer_id:
        raise ForbiddenError("Quality assessment is assigned to another reviewer")
    form = quality_form(db, item.project_id)
    config = quality_config(db, item.project_id)
    if form is None or config is None or not form.active_version_id:
        raise NotFoundError("Quality assessment configuration not found")
    fields = active_fields(db, form)
    validate_answers(fields, answers)
    current = db.scalar(
        select(QualityResponse).where(
            QualityResponse.work_item_id == item.id,
            QualityResponse.is_current.is_(True),
        )
    )
    version = 1
    if current:
        current.is_current = False
        version = current.version + 1
    total = (
        score_response(fields, answers, config.aggregation)
        if config.mode in {"numeric", "both"}
        else None
    )
    response = QualityResponse(
        work_item_id=item.id,
        reviewer_id=reviewer_id,
        form_version_id=form.active_version_id,
        answers=answers,
        total_score=total,
        version=version,
    )
    db.add(response)
    item.status = QualityStatus.COMPLETED
    item.completed_at = utcnow()
    item.reserved_until = None
    item.draft = {}
    db.flush()
    return response


def list_completed_for_reviewer(
    db: Session, project_id: str, reviewer_id: str
) -> list[tuple[QualityWorkItem, QualityResponse]]:
    """The reviewer's own completed quality assessments, paired with their
    current response, so they can be revisited and corrected after submission."""
    items = list(
        db.scalars(
            select(QualityWorkItem)
            .where(
                QualityWorkItem.project_id == project_id,
                QualityWorkItem.assigned_reviewer_id == reviewer_id,
                QualityWorkItem.status == QualityStatus.COMPLETED,
            )
            .order_by(QualityWorkItem.completed_at.desc())
        )
    )
    pairs: list[tuple[QualityWorkItem, QualityResponse]] = []
    for item in items:
        response = db.scalar(
            select(QualityResponse).where(
                QualityResponse.work_item_id == item.id,
                QualityResponse.is_current.is_(True),
            )
        )
        if response is not None:
            pairs.append((item, response))
    return pairs


def reopen_for_required_field(db: Session, project_id: str) -> int:
    items = list(
        db.scalars(
            select(QualityWorkItem).where(
                QualityWorkItem.project_id == project_id,
                QualityWorkItem.status == QualityStatus.COMPLETED,
            )
        )
    )
    for item in items:
        item.status = QualityStatus.AVAILABLE
        item.completed_at = None
        item.reserved_until = None
    db.flush()
    return len(items)
