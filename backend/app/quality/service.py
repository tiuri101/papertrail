from __future__ import annotations

import hashlib
from datetime import timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.accounts.models import User
from app.api.errors import DomainError, ForbiddenError, NotFoundError
from app.core.time import utcnow
from app.extraction.service import normalize_answers
from app.forms.models import FieldType, FormField, FormKind, ReviewForm
from app.forms.service import active_fields as forms_active_fields
from app.forms.service import project_form_by_kind
from app.forms.validation import as_number, validate_answers
from app.projects.models import (
    Project,
    ProjectMembership,
    TaskAllocationMode,
)
from app.projects.service import reviewer_weights, weighted_round_robin_sequence
from app.quality.models import (
    QualityAggregation,
    QualityConfig,
    QualityMode,
    QualityResponse,
    QualityStatus,
    QualityWorkItem,
)
from app.review_work.allocation import reassign_orphaned_items, rebalance_pending_items
from app.review_work.eligibility import (
    ReviewCapability,
    require_reviewer_capability_by_id,
)
from app.review_work.progress import (
    completed_items_with_response,
    remaining_claimable_items,
    reviewer_progress,
)
from app.review_work.structural_config import (
    StructuralSettingLockedError,
    work_items_exist,
)
from app.screening.cohorts import full_text_included_ids


def quality_config(db: Session, project_id: str) -> QualityConfig | None:
    return db.scalar(
        select(QualityConfig).where(QualityConfig.project_id == project_id)
    )


def quality_form(db: Session, project_id: str) -> ReviewForm | None:
    return project_form_by_kind(db, project_id, FormKind.QUALITY)


def quality_work_started(db: Session, project_id: str) -> bool:
    """Whether this project has generated any quality work item yet.

    The quality counterpart of ``screening_work_started`` /
    ``extraction_work_started``: once a single item exists, how items are
    handed out is baked into rows nothing revisits (see
    app.review_work.structural_config).
    """
    return work_items_exist(
        db, QualityWorkItem.id, QualityWorkItem.project_id == project_id
    )


def quality_responses_exist(db: Session, project_id: str) -> bool:
    """Whether any reviewer has submitted a quality assessment yet."""
    return work_items_exist(
        db,
        QualityResponse.id,
        QualityResponse.work_item_id == QualityWorkItem.id,
        QualityWorkItem.project_id == project_id,
    )


def update_quality_config(
    db: Session,
    project_id: str,
    *,
    enabled: bool,
    mode: QualityMode,
    aggregation: QualityAggregation,
    allocation_mode: TaskAllocationMode,
) -> QualityConfig:
    """Apply the project's quality-assessment configuration, refusing
    structural changes once the state they determine already exists.

    Two different freeze points, because the two kinds of setting are baked
    into two different kinds of row:

    * ``allocation_mode`` freezes as soon as a **work item** exists, exactly
      as screening and extraction do -- switching a pre-assigned stage to
      claim mode strands every existing item (the claim query only offers
      *unassigned* items), and the reverse hides the open pool from everyone.
    * ``mode`` and ``aggregation`` freeze once a **response** exists. They are
      structural in the sense that matters here: ``QualityResponse.total_score``
      is computed from them at submission time and then stored, and nothing
      recomputes it afterwards. Changing either one later leaves a project
      holding scores derived under two different rules -- some summed, some
      averaged, some absent because the mode was qualitative at the time --
      with no way to tell them apart. That mirrors extraction freezing its
      reviewer count once responses exist rather than silently reinterpreting
      recorded work.

    ``enabled`` is *not* structural: it only gates whether further work is
    generated and whether reports include a quality section, so it stays
    editable at any point.
    """
    existing = quality_config(db, project_id)
    if existing is not None:
        if existing.allocation_mode != allocation_mode and quality_work_started(
            db, project_id
        ):
            raise StructuralSettingLockedError(
                "Cannot change the allocation mode after quality work items "
                "exist for this project",
                setting="allocationMode",
                stage="quality",
            )
        scoring_changes = {
            "mode": existing.mode != mode,
            "aggregation": existing.aggregation != aggregation,
        }
        changed = [setting for setting, differs in scoring_changes.items() if differs]
        if changed and quality_responses_exist(db, project_id):
            labels = {
                "mode": "the assessment mode",
                "aggregation": "the score aggregation",
            }
            raise StructuralSettingLockedError(
                f"Cannot change {labels[changed[0]]} after quality assessments "
                "have been submitted for this project",
                setting=changed[0],
                stage="quality",
            )
    config = existing
    if config is None:
        config = QualityConfig(project_id=project_id)
        db.add(config)
    config.enabled = enabled
    config.mode = mode
    config.aggregation = aggregation
    config.allocation_mode = allocation_mode
    db.flush()
    return config


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
    return full_text_included_ids(db, project_id)


def initialize_quality(db: Session, project: Project) -> int:
    config = quality_config(db, project.id)
    if config is None or not config.enabled:
        return 0
    if quality_form(db, project.id) is None:
        raise DomainError("Quality assessment is enabled but no quality form exists")
    reviewers = eligible_assessors(db, project.id)
    if not reviewers:
        raise DomainError("At least one eligible quality assessor is required")
    claim_mode = config.allocation_mode == TaskAllocationMode.CLAIM
    publication_ids = sorted(included_publication_ids(db, project.id))
    assignment_sequence = (
        []
        if claim_mode
        else weighted_round_robin_sequence(
            reviewers,
            reviewer_weights(db, project.id, reviewers),
            len(publication_ids),
        )
    )
    created = 0
    for index, publication_id in enumerate(publication_ids):
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
                assigned_reviewer_id=None if claim_mode else assignment_sequence[index],
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

    In claim mode, orphaned items are released back to the open pool (unassigned)
    instead of being pushed onto a specific reviewer.
    """
    eligible = eligible_assessors(db, project_id)
    if not eligible:
        return 0
    config = quality_config(db, project_id)
    claim_mode = (
        config is not None and config.allocation_mode == TaskAllocationMode.CLAIM
    )
    return reassign_orphaned_items(
        db,
        QualityWorkItem,
        project_id=project_id,
        eligible=eligible,
        claim_mode=claim_mode,
        completed_status=QualityStatus.COMPLETED,
        available_status=QualityStatus.AVAILABLE,
    )


def rebalance_pending_work_items(db: Session, project_id: str) -> int:
    """Spread not-yet-claimed (AVAILABLE) quality work items evenly across all
    currently eligible assessors, so someone just granted access picks up a fair
    share of the backlog. Reserved and completed items are left untouched.

    A no-op in claim mode: AVAILABLE items there are an intentionally open pool
    for reviewers to pick from, not a backlog to pre-assign.
    """
    config = quality_config(db, project_id)
    if config is not None and config.allocation_mode == TaskAllocationMode.CLAIM:
        return 0
    eligible = eligible_assessors(db, project_id)
    if not eligible:
        return 0
    weights = reviewer_weights(db, project_id, eligible)
    return rebalance_pending_items(
        db,
        QualityWorkItem,
        project_id=project_id,
        eligible=eligible,
        weights=weights,
        available_status=QualityStatus.AVAILABLE,
    )


def remaining_claimable_assessments(
    db: Session, project_id: str, reviewer_id: str
) -> int:
    """How many quality-assessment work items this reviewer could still claim
    or complete in claim mode: their own incomplete items plus unclaimed ones."""
    return remaining_claimable_items(
        db,
        QualityWorkItem,
        project_id=project_id,
        reviewer_id=reviewer_id,
        completed_status=QualityStatus.COMPLETED,
    )


def my_progress(
    db: Session, project_id: str, reviewer_id: str
) -> dict[str, int | bool]:
    """How many quality-assessment work items this reviewer has been assigned,
    and how many of those they've already completed. In claim mode, work items
    start unassigned, so also report how many are still available to this
    reviewer."""
    config = quality_config(db, project_id)
    claim_mode = (
        config is not None and config.allocation_mode == TaskAllocationMode.CLAIM
    )
    remaining = (
        remaining_claimable_assessments(db, project_id, reviewer_id)
        if claim_mode
        else 0
    )
    return reviewer_progress(
        db,
        QualityWorkItem,
        project_id=project_id,
        reviewer_id=reviewer_id,
        completed_status=QualityStatus.COMPLETED,
        claim_mode=claim_mode,
        remaining=remaining,
    )


def claim_next_quality(
    db: Session,
    project_id: str,
    reviewer_id: str,
    excluded_item_ids: set[str] | None = None,
) -> QualityWorkItem | None:
    require_reviewer_capability_by_id(
        db, project_id, reviewer_id, ReviewCapability.QUALITY
    )
    now = utcnow()
    config = quality_config(db, project_id)
    claim_mode = (
        config is not None and config.allocation_mode == TaskAllocationMode.CLAIM
    )
    assignment_filter = (
        QualityWorkItem.assigned_reviewer_id.is_(None)
        if claim_mode
        else QualityWorkItem.assigned_reviewer_id == reviewer_id
    )
    query = (
        select(QualityWorkItem)
        .where(
            assignment_filter,
            QualityWorkItem.project_id == project_id,
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
        if claim_mode:
            item.assigned_reviewer_id = reviewer_id
        item.status = QualityStatus.RESERVED
        item.reserved_until = now + timedelta(hours=1)
        db.flush()
    return item


def save_draft(
    db: Session, item: QualityWorkItem, reviewer_id: str, draft: dict[str, Any]
) -> None:
    require_reviewer_capability_by_id(
        db, item.project_id, reviewer_id, ReviewCapability.QUALITY
    )
    if (
        item.assigned_reviewer_id != reviewer_id
        or item.status == QualityStatus.COMPLETED
    ):
        raise ForbiddenError("This quality-assessment work item cannot be edited")
    item.draft = draft


def release_quality_item(
    db: Session, item: QualityWorkItem, reviewer_id: str
) -> None:
    """Hand a reserved quality assessment back to the queue."""
    require_reviewer_capability_by_id(
        db, item.project_id, reviewer_id, ReviewCapability.QUALITY
    )
    if item.assigned_reviewer_id != reviewer_id:
        raise ForbiddenError("Quality assessment is assigned to another reviewer")
    if item.status != QualityStatus.COMPLETED:
        item.status = QualityStatus.AVAILABLE
        item.reserved_until = None


def active_fields(db: Session, form: ReviewForm) -> list[FormField]:
    return forms_active_fields(db, form)


def score_response(
    fields: list[FormField], answers: dict[str, Any], aggregation: QualityAggregation
) -> float | None:
    """Combine a submitted answer set into one numeric quality score.

    Every value that reaches arithmetic here goes through ``as_number``, which
    excludes ``bool``: ``isinstance(True, int)`` is ``True`` in Python, so an
    answer (or a misconfigured weight or option score) of ``True`` would
    otherwise be counted as ``1`` and produce a plausible-looking score that
    no reviewer ever gave. A checkbox contributes only through its own
    ``true``/``false`` scoring map, never as the number 1 or 0.
    """
    weighted_values: list[tuple[float, float]] = []
    for field in fields:
        value = answers.get(field.stable_key)
        if value is None:
            continue
        scoring = field.scoring or {}
        weight = as_number(scoring.get("weight", 1))
        if weight is None:
            weight = 1.0
        score: float | None = None
        if field.field_type in {FieldType.NUMBER, FieldType.RATING}:
            score = as_number(value)
        elif field.field_type == FieldType.SINGLE_SELECT and isinstance(value, str):
            values = scoring.get("values")
            if isinstance(values, dict):
                score = as_number(values.get(value))
        elif field.field_type == FieldType.CHECKBOX and isinstance(value, bool):
            score = as_number(scoring.get("true" if value else "false"))
        if score is not None:
            weighted_values.append((score, weight))
    if not weighted_values:
        return None
    total = sum(score * weight for score, weight in weighted_values)
    if aggregation == QualityAggregation.WEIGHTED_AVERAGE:
        denominator = sum(weight for _, weight in weighted_values)
        return total / denominator if denominator else None
    if aggregation == QualityAggregation.AVERAGE:
        return sum(score for score, _ in weighted_values) / len(weighted_values)
    if aggregation == QualityAggregation.SUM:
        return total
    # Unreachable while ``aggregation`` is a QualityAggregation, which is the
    # point: an unrecognized aggregation used to fall through to a plain sum.
    raise DomainError(f"Unsupported quality score aggregation: {aggregation}")


def submit_quality(
    db: Session, item: QualityWorkItem, reviewer_id: str, answers: dict[str, Any]
) -> QualityResponse:
    require_reviewer_capability_by_id(
        db, item.project_id, reviewer_id, ReviewCapability.QUALITY
    )
    if item.assigned_reviewer_id != reviewer_id:
        raise ForbiddenError("Quality assessment is assigned to another reviewer")
    form = quality_form(db, item.project_id)
    config = quality_config(db, item.project_id)
    if form is None or config is None or not form.active_version_id:
        raise NotFoundError("Quality assessment configuration not found")
    fields = active_fields(db, form)
    answers = normalize_answers(fields, answers)
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
        if config.mode in {QualityMode.NUMERIC, QualityMode.BOTH}
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
    return completed_items_with_response(
        db,
        QualityWorkItem,
        QualityResponse,
        project_id=project_id,
        reviewer_id=reviewer_id,
        completed_status=QualityStatus.COMPLETED,
    )


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
