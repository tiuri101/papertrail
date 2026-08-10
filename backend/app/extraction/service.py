from __future__ import annotations

import hashlib
from collections.abc import Mapping
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import case, func, or_, select
from sqlalchemy.orm import Session

from app.accounts.models import User
from app.api.errors import DomainError, ForbiddenError, NotFoundError
from app.conflicts.models import FinalDecision
from app.extraction.models import (
    ExtractionConfig,
    ExtractionResponse,
    ExtractionStatus,
    ExtractionWorkItem,
)
from app.forms.models import FieldType, FormField, FormKind, ReviewForm
from app.projects.models import (
    Project,
    ProjectMembership,
    ScreeningStage,
    TaskAllocationMode,
)
from app.projects.service import reviewer_weights, weighted_round_robin_sequence
from app.screening.models import ScreeningOutcome


def utcnow() -> datetime:
    return datetime.now(UTC)


def project_form(db: Session, project_id: str) -> ReviewForm | None:
    return db.scalar(
        select(ReviewForm).where(
            ReviewForm.project_id == project_id, ReviewForm.kind == FormKind.EXTRACTION
        )
    )


def eligible_extractors(db: Session, project_id: str) -> list[str]:
    members = list(
        db.scalars(
            select(User.id)
            .join(ProjectMembership, ProjectMembership.user_id == User.id)
            .where(
                ProjectMembership.project_id == project_id,
                ProjectMembership.can_extract.is_(True),
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


def get_extraction_config(db: Session, project_id: str) -> ExtractionConfig | None:
    return db.scalar(
        select(ExtractionConfig).where(ExtractionConfig.project_id == project_id)
    )


def extraction_allocation_mode(db: Session, project_id: str) -> TaskAllocationMode:
    config = get_extraction_config(db, project_id)
    return config.allocation_mode if config else TaskAllocationMode.CLAIM


def initialize_extraction(db: Session, project: Project) -> int:
    if project_form(db, project.id) is None:
        return 0
    reviewers = eligible_extractors(db, project.id)
    if not reviewers:
        raise DomainError("At least one eligible extraction reviewer is required")
    claim_mode = extraction_allocation_mode(db, project.id) == TaskAllocationMode.CLAIM
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
            select(ExtractionWorkItem.id).where(
                ExtractionWorkItem.publication_id == publication_id
            )
        ):
            continue
        rank = hashlib.sha256(
            f"{project.random_seed}:{project.id}:{publication_id}:extraction".encode()
        ).hexdigest()
        db.add(
            ExtractionWorkItem(
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
    """Redistribute not-yet-completed extraction work items away from reviewers who
    are no longer eligible to extract (removed from the project, or had the
    extraction permission turned off), spreading them round-robin across whoever is
    currently eligible.

    Mirrors screening's function of the same name: assignment happens once, at
    creation time, so nothing else revisits it -- if a reviewer's eligibility is
    revoked afterward, their existing AVAILABLE/RESERVED items would otherwise sit
    assigned to someone who can no longer claim them. Completed items are left
    untouched: who actually extracted a publication shouldn't change after the fact.

    In claim mode, orphaned items are released back to the open pool (unassigned)
    instead of being pushed onto a specific reviewer.
    """
    eligible = eligible_extractors(db, project_id)
    if not eligible:
        return 0
    claim_mode = extraction_allocation_mode(db, project_id) == TaskAllocationMode.CLAIM
    orphaned = list(
        db.scalars(
            select(ExtractionWorkItem)
            .where(
                ExtractionWorkItem.project_id == project_id,
                ExtractionWorkItem.status != ExtractionStatus.COMPLETED,
                ExtractionWorkItem.assigned_reviewer_id.is_not(None),
                ExtractionWorkItem.assigned_reviewer_id.not_in(eligible),
            )
            .order_by(ExtractionWorkItem.random_rank)
        )
    )
    for index, item in enumerate(orphaned):
        item.assigned_reviewer_id = (
            None if claim_mode else eligible[index % len(eligible)]
        )
        item.status = ExtractionStatus.AVAILABLE
        item.reserved_until = None
    db.flush()
    return len(orphaned)


def rebalance_pending_work_items(db: Session, project_id: str) -> int:
    """Spread not-yet-claimed (AVAILABLE) extraction work items evenly across all
    currently eligible extractors, so someone just granted access picks up a fair
    share of the backlog. Reserved and completed items are left untouched.

    A no-op in claim mode: AVAILABLE items there are an intentionally open pool
    for reviewers to pick from, not a backlog to pre-assign.
    """
    if extraction_allocation_mode(db, project_id) == TaskAllocationMode.CLAIM:
        return 0
    eligible = eligible_extractors(db, project_id)
    if not eligible:
        return 0
    weights = reviewer_weights(db, project_id, eligible)
    items = list(
        db.scalars(
            select(ExtractionWorkItem)
            .where(ExtractionWorkItem.project_id == project_id)
            .order_by(ExtractionWorkItem.random_rank)
        )
    )
    load = {reviewer_id: 0 for reviewer_id in eligible}
    pending: list[ExtractionWorkItem] = []
    for item in items:
        if item.status == ExtractionStatus.AVAILABLE:
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


def remaining_claimable_extractions(
    db: Session, project_id: str, reviewer_id: str
) -> int:
    """How many extraction work items this reviewer could still claim or
    complete in claim mode: their own incomplete items plus unclaimed ones."""
    return (
        db.scalar(
            select(func.count())
            .select_from(ExtractionWorkItem)
            .where(
                ExtractionWorkItem.project_id == project_id,
                ExtractionWorkItem.status != ExtractionStatus.COMPLETED,
                or_(
                    ExtractionWorkItem.assigned_reviewer_id == reviewer_id,
                    ExtractionWorkItem.assigned_reviewer_id.is_(None),
                ),
            )
        )
        or 0
    )


def my_progress(
    db: Session, project_id: str, reviewer_id: str
) -> dict[str, int | bool]:
    """How many extraction work items this reviewer has been assigned, and how
    many of those they've already completed. In claim mode, work items start
    unassigned, so also report how many are still available to this reviewer."""
    assigned = (
        db.scalar(
            select(func.count())
            .select_from(ExtractionWorkItem)
            .where(
                ExtractionWorkItem.project_id == project_id,
                ExtractionWorkItem.assigned_reviewer_id == reviewer_id,
            )
        )
        or 0
    )
    completed = (
        db.scalar(
            select(func.count())
            .select_from(ExtractionWorkItem)
            .where(
                ExtractionWorkItem.project_id == project_id,
                ExtractionWorkItem.assigned_reviewer_id == reviewer_id,
                ExtractionWorkItem.status == ExtractionStatus.COMPLETED,
            )
        )
        or 0
    )
    claim_mode = extraction_allocation_mode(db, project_id) == TaskAllocationMode.CLAIM
    remaining = (
        remaining_claimable_extractions(db, project_id, reviewer_id)
        if claim_mode
        else 0
    )
    return {
        "assigned": assigned,
        "completed": completed,
        "remaining": remaining,
        "claim_mode": claim_mode,
    }


def claim_next_extraction(
    db: Session,
    project_id: str,
    reviewer_id: str,
    excluded_item_ids: set[str] | None = None,
) -> ExtractionWorkItem | None:
    now = utcnow()
    claim_mode = extraction_allocation_mode(db, project_id) == TaskAllocationMode.CLAIM
    # A reviewer's own reserved-but-not-completed item is always resumed first,
    # regardless of allocation mode, so an interrupted session doesn't lose its
    # place in the queue.
    own_reserved = (
        select(ExtractionWorkItem)
        .where(
            ExtractionWorkItem.project_id == project_id,
            ExtractionWorkItem.assigned_reviewer_id == reviewer_id,
            ExtractionWorkItem.status == ExtractionStatus.RESERVED,
        )
        .order_by(ExtractionWorkItem.random_rank)
        .limit(1)
    )
    if excluded_item_ids:
        own_reserved = own_reserved.where(
            ExtractionWorkItem.id.not_in(excluded_item_ids)
        )
    item = db.scalar(own_reserved)
    if item is None:
        assignment_filter = (
            ExtractionWorkItem.assigned_reviewer_id.is_(None)
            if claim_mode
            else ExtractionWorkItem.assigned_reviewer_id == reviewer_id
        )
        query = (
            select(ExtractionWorkItem)
            .where(
                assignment_filter,
                ExtractionWorkItem.project_id == project_id,
                ExtractionWorkItem.status != ExtractionStatus.COMPLETED,
            )
            .order_by(
                case(
                    (ExtractionWorkItem.status == ExtractionStatus.RESERVED, 0),
                    else_=1,
                ),
                ExtractionWorkItem.random_rank,
            )
            .limit(1)
        )
        if excluded_item_ids:
            query = query.where(ExtractionWorkItem.id.not_in(excluded_item_ids))
        if db.bind is not None and db.bind.dialect.name == "postgresql":
            query = query.with_for_update(skip_locked=True)
        item = db.scalar(query)
    if item:
        if claim_mode:
            item.assigned_reviewer_id = reviewer_id
        item.status = ExtractionStatus.RESERVED
        item.reserved_until = now + timedelta(hours=1)
        db.flush()
    return item


def save_draft(
    item: ExtractionWorkItem, reviewer_id: str, draft: dict[str, Any]
) -> None:
    if (
        item.assigned_reviewer_id != reviewer_id
        or item.status == ExtractionStatus.COMPLETED
    ):
        raise ForbiddenError("This extraction work item cannot be edited")
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


def validate_answers(fields: list[FormField], answers: dict[str, Any]) -> None:
    known = {field.stable_key: field for field in fields}
    unknown = set(answers) - set(known)
    if unknown:
        raise DomainError(f"Unknown form fields: {', '.join(sorted(unknown))}")
    for key, field in known.items():
        value = answers.get(key)
        if field.required and value in (None, "", []):
            raise DomainError(f"Required field is missing: {field.label}")
        if value is None:
            continue
        if field.field_type == FieldType.NUMBER and not isinstance(value, (int, float)):
            raise DomainError(f"Expected a number for: {field.label}")
        if field.field_type == FieldType.CHECKBOX and not isinstance(value, bool):
            raise DomainError(f"Expected a boolean for: {field.label}")
        if field.field_type == FieldType.MULTIPLE_SELECT and not isinstance(
            value, list
        ):
            raise DomainError(f"Expected a list for: {field.label}")
        if (
            field.field_type == FieldType.SINGLE_SELECT
            and field.options
            and value not in field.options
        ):
            raise DomainError(f"Invalid option for: {field.label}")
        if (
            field.field_type == FieldType.MULTIPLE_SELECT
            and field.options
            and any(item not in field.options for item in value)
        ):
            raise DomainError(f"Invalid option for: {field.label}")


def submit_extraction(
    db: Session,
    item: ExtractionWorkItem,
    reviewer_id: str,
    answers: dict[str, Any],
    *,
    suggestion_actions: Mapping[str, str] | None = None,
) -> ExtractionResponse:
    if item.assigned_reviewer_id != reviewer_id:
        raise ForbiddenError("Extraction is assigned to another reviewer")
    form = project_form(db, item.project_id)
    if form is None or not form.active_version_id:
        raise NotFoundError("Extraction form not found")
    validate_answers(active_fields(db, form), answers)
    current = db.scalar(
        select(ExtractionResponse).where(
            ExtractionResponse.work_item_id == item.id,
            ExtractionResponse.is_current.is_(True),
        )
    )
    version = 1
    if current:
        current.is_current = False
        version = current.version + 1
    response = ExtractionResponse(
        work_item_id=item.id,
        reviewer_id=reviewer_id,
        form_version_id=form.active_version_id,
        answers=answers,
        version=version,
    )
    db.add(response)
    db.flush()
    from app.llm.service import record_suggestion_provenance

    record_suggestion_provenance(
        db, item, response, suggestion_actions=suggestion_actions
    )
    item.status = ExtractionStatus.COMPLETED
    item.reserved_until = None
    item.completed_at = utcnow()
    item.draft = {}
    db.flush()
    from app.llm.task_service import queue_project_extraction_validations

    queue_project_extraction_validations(
        db, item.project_id, created_by_id=reviewer_id, priority=10
    )
    db.flush()
    return response


def override_extraction(
    db: Session,
    item: ExtractionWorkItem,
    actor_id: str,
    answers: dict[str, Any],
) -> tuple[ExtractionResponse, ExtractionResponse]:
    """Record an owner override as a new immutable extraction response version."""
    current = db.scalar(
        select(ExtractionResponse).where(
            ExtractionResponse.work_item_id == item.id,
            ExtractionResponse.is_current.is_(True),
        )
    )
    if current is None:
        raise DomainError(
            "A completed extraction is required before it can be overridden"
        )
    fields = list(
        db.scalars(
            select(FormField)
            .where(FormField.form_version_id == current.form_version_id)
            .order_by(FormField.position)
        )
    )
    validate_answers(fields, answers)
    current.is_current = False
    response = ExtractionResponse(
        work_item_id=item.id,
        reviewer_id=actor_id,
        form_version_id=current.form_version_id,
        answers=answers,
        version=current.version + 1,
    )
    db.add(response)
    item.status = ExtractionStatus.COMPLETED
    item.reserved_until = None
    item.completed_at = utcnow()
    item.draft = {}
    db.flush()

    from app.llm.task_service import queue_project_extraction_validations

    queue_project_extraction_validations(
        db, item.project_id, created_by_id=actor_id, priority=10
    )
    db.flush()
    return response, current


def list_completed_for_reviewer(
    db: Session, project_id: str, reviewer_id: str
) -> list[tuple[ExtractionWorkItem, ExtractionResponse]]:
    """The reviewer's own completed extractions, paired with their current
    response, so they can be revisited and corrected after submission."""
    items = list(
        db.scalars(
            select(ExtractionWorkItem)
            .where(
                ExtractionWorkItem.project_id == project_id,
                ExtractionWorkItem.assigned_reviewer_id == reviewer_id,
                ExtractionWorkItem.status == ExtractionStatus.COMPLETED,
            )
            .order_by(ExtractionWorkItem.completed_at.desc())
        )
    )
    pairs: list[tuple[ExtractionWorkItem, ExtractionResponse]] = []
    for item in items:
        response = db.scalar(
            select(ExtractionResponse).where(
                ExtractionResponse.work_item_id == item.id,
                ExtractionResponse.is_current.is_(True),
            )
        )
        if response is not None:
            pairs.append((item, response))
    return pairs


def reopen_for_required_field(db: Session, project_id: str) -> int:
    items = list(
        db.scalars(
            select(ExtractionWorkItem).where(
                ExtractionWorkItem.project_id == project_id,
                ExtractionWorkItem.status == ExtractionStatus.COMPLETED,
            )
        )
    )
    for item in items:
        item.status = ExtractionStatus.AVAILABLE
        item.completed_at = None
        item.reserved_until = None
    db.flush()
    return len(items)
