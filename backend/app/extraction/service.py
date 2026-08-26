from __future__ import annotations

import hashlib
from collections.abc import Mapping
from datetime import timedelta
from typing import Any

from sqlalchemy import case, select
from sqlalchemy.orm import Session, aliased

from app.accounts.models import User
from app.api.errors import DomainError, ForbiddenError, NotFoundError
from app.core.time import utcnow
from app.extraction.models import (
    ExtractionConfig,
    ExtractionResponse,
    ExtractionStatus,
    ExtractionWorkItem,
)
from app.forms.models import FieldType, FormField, FormKind, ReviewForm
from app.forms.service import active_fields as forms_active_fields
from app.forms.service import project_form_by_kind
from app.forms.validation import validate_answers as validate_form_answers
from app.projects.models import (
    Project,
    ProjectMembership,
    TaskAllocationMode,
)
from app.projects.service import reviewer_weights, weighted_round_robin_sequence
from app.review_work.allocation import reassign_orphaned_items, rebalance_pending_items
from app.review_work.eligibility import (
    ReviewCapability,
    require_reviewer_capability_by_id,
)
from app.review_work.finalization import lock_publication_for_finalization
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

MAX_REQUIRED_REVIEWERS = 2


def project_form(db: Session, project_id: str) -> ReviewForm | None:
    return project_form_by_kind(db, project_id, FormKind.EXTRACTION)


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
    return full_text_included_ids(db, project_id)


def get_extraction_config(db: Session, project_id: str) -> ExtractionConfig | None:
    return db.scalar(
        select(ExtractionConfig).where(ExtractionConfig.project_id == project_id)
    )


def extraction_allocation_mode(db: Session, project_id: str) -> TaskAllocationMode:
    config = get_extraction_config(db, project_id)
    return config.allocation_mode if config else TaskAllocationMode.CLAIM


def extraction_required_reviewers(db: Session, project_id: str) -> int:
    config = get_extraction_config(db, project_id)
    return config.required_reviewers if config else 1


def extraction_work_started(db: Session, project_id: str) -> bool:
    """Whether this project has generated any extraction work item yet.

    The extraction counterpart of ``screening_work_started``: once a single
    slot exists, the number of slots per publication and how they are handed
    out are baked into rows nothing revisits, so both settings freeze. This is
    stricter than the previous "has anyone submitted a response" test -- an
    empty pre-assigned slot is stranded by a switch to claim mode just as
    surely as a completed one.
    """
    return work_items_exist(
        db, ExtractionWorkItem.id, ExtractionWorkItem.project_id == project_id
    )


def update_extraction_config(
    db: Session,
    project_id: str,
    *,
    allocation_mode: TaskAllocationMode,
    required_reviewers: int,
) -> ExtractionConfig:
    """Apply the project's extraction configuration, refusing structural
    changes once extraction work items exist (see
    app.review_work.structural_config)."""
    if not 1 <= required_reviewers <= MAX_REQUIRED_REVIEWERS:
        raise DomainError(
            f"Extractors per publication must be between 1 and "
            f"{MAX_REQUIRED_REVIEWERS}"
        )
    existing = get_extraction_config(db, project_id)
    if existing is not None:
        structural_changes = {
            "requiredReviewers": existing.required_reviewers != required_reviewers,
            "allocationMode": existing.allocation_mode != allocation_mode,
        }
        changed = [
            setting for setting, differs in structural_changes.items() if differs
        ]
        if changed and extraction_work_started(db, project_id):
            labels = {
                "requiredReviewers": "extractors per publication",
                "allocationMode": "the allocation mode",
            }
            raise StructuralSettingLockedError(
                f"Cannot change {labels[changed[0]]} after extraction work items "
                "exist for this project",
                setting=changed[0],
                stage="extraction",
            )
    config = existing
    if config is None:
        config = ExtractionConfig(project_id=project_id)
        db.add(config)
    config.allocation_mode = allocation_mode
    config.required_reviewers = required_reviewers
    db.flush()
    return config


def initialize_extraction(db: Session, project: Project) -> int:
    if project_form(db, project.id) is None:
        return 0
    required = extraction_required_reviewers(db, project.id)
    reviewers = eligible_extractors(db, project.id)
    if len(reviewers) < required:
        if required > 1:
            raise DomainError(
                f"At least {required} eligible extraction reviewers are required "
                "for dual extraction"
            )
        raise DomainError("At least one eligible extraction reviewer is required")
    claim_mode = extraction_allocation_mode(db, project.id) == TaskAllocationMode.CLAIM
    publication_ids = sorted(included_publication_ids(db, project.id))
    assignment_sequence = (
        []
        if claim_mode
        else weighted_round_robin_sequence(
            reviewers,
            reviewer_weights(db, project.id, reviewers),
            len(publication_ids) * required,
        )
    )
    created = 0
    sequence_index = 0
    for publication_id in publication_ids:
        existing_slots = set(
            db.scalars(
                select(ExtractionWorkItem.slot_number).where(
                    ExtractionWorkItem.publication_id == publication_id
                )
            )
        )
        assigned_this_publication: set[str] = set(
            db.scalars(
                select(ExtractionWorkItem.assigned_reviewer_id).where(
                    ExtractionWorkItem.publication_id == publication_id,
                    ExtractionWorkItem.assigned_reviewer_id.is_not(None),
                )
            )
        )
        for slot_number in range(1, required + 1):
            if slot_number in existing_slots:
                continue
            assignee = None
            if not claim_mode:
                # Draw the next eligible reviewer in rotation who isn't
                # already assigned another slot for this same publication,
                # guaranteeing distinct reviewers across slots.
                while sequence_index < len(assignment_sequence):
                    candidate = assignment_sequence[sequence_index]
                    sequence_index += 1
                    if candidate not in assigned_this_publication:
                        assignee = candidate
                        break
                if assignee is None:
                    remaining = [
                        r for r in reviewers if r not in assigned_this_publication
                    ]
                    assignee = remaining[0] if remaining else reviewers[0]
                assigned_this_publication.add(assignee)
            rank = hashlib.sha256(
                f"{project.random_seed}:{project.id}:{publication_id}:"
                f"{slot_number}:extraction".encode()
            ).hexdigest()
            db.add(
                ExtractionWorkItem(
                    project_id=project.id,
                    publication_id=publication_id,
                    slot_number=slot_number,
                    assigned_reviewer_id=assignee,
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
    reassigned = reassign_orphaned_items(
        db,
        ExtractionWorkItem,
        project_id=project_id,
        eligible=eligible,
        claim_mode=claim_mode,
        completed_status=ExtractionStatus.COMPLETED,
        available_status=ExtractionStatus.AVAILABLE,
    )
    if not claim_mode:
        _ensure_distinct_slot_assignments(db, project_id, eligible)
    return reassigned


def _ensure_distinct_slot_assignments(
    db: Session, project_id: str, eligible: list[str]
) -> None:
    """Safety net for PRE_ASSIGNED dual extraction: if reassignment or
    rebalancing ever left two not-yet-completed slots of the same
    publication assigned to the same reviewer, swap one to a different
    eligible reviewer not already on that publication."""
    if len(eligible) < 2:
        return
    items = list(
        db.scalars(
            select(ExtractionWorkItem)
            .where(
                ExtractionWorkItem.project_id == project_id,
                ExtractionWorkItem.status != ExtractionStatus.COMPLETED,
            )
            .order_by(ExtractionWorkItem.publication_id, ExtractionWorkItem.slot_number)
        )
    )
    by_publication: dict[str, list[ExtractionWorkItem]] = {}
    for item in items:
        by_publication.setdefault(item.publication_id, []).append(item)
    for pub_items in by_publication.values():
        seen: set[str] = set()
        for item in pub_items:
            if item.assigned_reviewer_id is None:
                continue
            if item.assigned_reviewer_id in seen:
                replacement = next((r for r in eligible if r not in seen), None)
                if replacement is not None:
                    item.assigned_reviewer_id = replacement
                    seen.add(replacement)
            else:
                seen.add(item.assigned_reviewer_id)
    db.flush()


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
    reassigned = rebalance_pending_items(
        db,
        ExtractionWorkItem,
        project_id=project_id,
        eligible=eligible,
        weights=weights,
        available_status=ExtractionStatus.AVAILABLE,
    )
    _ensure_distinct_slot_assignments(db, project_id, eligible)
    return reassigned


def remaining_claimable_extractions(
    db: Session, project_id: str, reviewer_id: str
) -> int:
    """How many extraction work items this reviewer could still claim or
    complete in claim mode: their own incomplete items plus unclaimed ones."""
    return remaining_claimable_items(
        db,
        ExtractionWorkItem,
        project_id=project_id,
        reviewer_id=reviewer_id,
        completed_status=ExtractionStatus.COMPLETED,
    )


def my_progress(
    db: Session, project_id: str, reviewer_id: str
) -> dict[str, int | bool]:
    """How many extraction work items this reviewer has been assigned, and how
    many of those they've already completed. In claim mode, work items start
    unassigned, so also report how many are still available to this reviewer."""
    claim_mode = extraction_allocation_mode(db, project_id) == TaskAllocationMode.CLAIM
    remaining = (
        remaining_claimable_extractions(db, project_id, reviewer_id)
        if claim_mode
        else 0
    )
    return reviewer_progress(
        db,
        ExtractionWorkItem,
        project_id=project_id,
        reviewer_id=reviewer_id,
        completed_status=ExtractionStatus.COMPLETED,
        claim_mode=claim_mode,
        remaining=remaining,
    )


def claim_next_extraction(
    db: Session,
    project_id: str,
    reviewer_id: str,
    excluded_item_ids: set[str] | None = None,
) -> ExtractionWorkItem | None:
    require_reviewer_capability_by_id(
        db, project_id, reviewer_id, ReviewCapability.EXTRACTION
    )
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
        if claim_mode:
            # Never let one reviewer claim two slots of the same publication:
            # exclude any work item whose publication already has another
            # slot (any status) assigned to this reviewer.
            sibling = aliased(ExtractionWorkItem)
            sibling_assigned = (
                select(sibling.id)
                .where(
                    sibling.publication_id == ExtractionWorkItem.publication_id,
                    sibling.assigned_reviewer_id == reviewer_id,
                )
                .correlate(ExtractionWorkItem)
                .exists()
            )
            query = query.where(~sibling_assigned)
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
    db: Session, item: ExtractionWorkItem, reviewer_id: str, draft: dict[str, Any]
) -> None:
    require_reviewer_capability_by_id(
        db, item.project_id, reviewer_id, ReviewCapability.EXTRACTION
    )
    if (
        item.assigned_reviewer_id != reviewer_id
        or item.status == ExtractionStatus.COMPLETED
    ):
        raise ForbiddenError("This extraction work item cannot be edited")
    item.draft = draft


def release_extraction_item(
    db: Session, item: ExtractionWorkItem, reviewer_id: str
) -> None:
    """Hand a reserved extraction slot back to the queue."""
    require_reviewer_capability_by_id(
        db, item.project_id, reviewer_id, ReviewCapability.EXTRACTION
    )
    if item.assigned_reviewer_id != reviewer_id:
        raise ForbiddenError("Extraction is assigned to another reviewer")
    if item.status != ExtractionStatus.COMPLETED:
        item.status = ExtractionStatus.AVAILABLE
        item.reserved_until = None


def slot_responses_visible(
    db: Session, work_item: ExtractionWorkItem, viewer_id: str
) -> bool:
    """Whether `viewer_id` may see the *other* extraction slot(s)' answers,
    drafts, or history for this work item's publication.

    Per-viewer and asymmetric, unlike screening's symmetric reveal-at-quorum
    gate: a reviewer only sees sibling slot data once their OWN slot is
    complete, regardless of whether the sibling slot is complete. In
    single-reviewer mode there is never a sibling to hide, so this is
    always true.
    """
    required = extraction_required_reviewers(db, work_item.project_id)
    if required <= 1:
        return True
    own_item = db.scalar(
        select(ExtractionWorkItem).where(
            ExtractionWorkItem.publication_id == work_item.publication_id,
            ExtractionWorkItem.assigned_reviewer_id == viewer_id,
        )
    )
    return own_item is not None and own_item.status == ExtractionStatus.COMPLETED


def active_fields(db: Session, form: ReviewForm) -> list[FormField]:
    return forms_active_fields(db, form)


def normalize_answers(
    fields: list[FormField], answers: dict[str, Any]
) -> dict[str, Any]:
    """Fill in the implicit default for field types whose UI control never fires
    a change event when left at its default -- an unchecked checkbox, or a
    multi-select with nothing picked, submits no key at all, indistinguishable
    from a field the reviewer never looked at. Without this, an explicit "no"
    (or "none selected") silently vanishes: it's missing from stored answers,
    so it renders as an absent field in history rather than as false/empty,
    and quality scoring skips a missing checkbox as unanswered rather than
    counting it as false.
    """
    normalized = dict(answers)
    for field in fields:
        if field.stable_key in normalized:
            continue
        if field.field_type == FieldType.CHECKBOX:
            normalized[field.stable_key] = False
        elif field.field_type == FieldType.MULTIPLE_SELECT:
            normalized[field.stable_key] = []
    return normalized


def validate_answers(fields: list[FormField], answers: dict[str, Any]) -> None:
    """Validate submitted extraction answers.

    A thin alias for the shared, FieldType-aware rule set in
    ``app.forms.validation`` -- extraction and quality must never diverge on
    what counts as a valid value for a field type, so neither of them owns
    the rules.
    """
    validate_form_answers(fields, answers)


def submit_extraction(
    db: Session,
    item: ExtractionWorkItem,
    reviewer_id: str,
    answers: dict[str, Any],
    *,
    suggestion_actions: Mapping[str, str] | None = None,
) -> ExtractionResponse:
    require_reviewer_capability_by_id(
        db, item.project_id, reviewer_id, ReviewCapability.EXTRACTION
    )
    if item.assigned_reviewer_id != reviewer_id:
        raise ForbiddenError("Extraction is assigned to another reviewer")
    # Serialize this publication's finalization for the rest of the
    # transaction: attempt_auto_finalize below reads *both* slots back, and
    # two extractors completing their slots concurrently would otherwise each
    # see only their own completed slot, each decide the publication is still
    # waiting on the other, and leave it with both slots done and neither a
    # FinalExtraction nor a recorded reconciliation-required state.
    lock_publication_for_finalization(db, item.publication_id)
    form = project_form(db, item.project_id)
    if form is None or not form.active_version_id:
        raise NotFoundError("Extraction form not found")
    fields = active_fields(db, form)
    answers = normalize_answers(fields, answers)
    validate_answers(fields, answers)
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

    # Must run before queue_project_extraction_validations below: validation
    # targets the authoritative FinalExtraction, which this submission may
    # just have created or invalidated (single-reviewer mode: immediately;
    # dual-reviewer mode: once both slots agree).
    from app.extraction.reconciliation import attempt_auto_finalize

    attempt_auto_finalize(db, item.publication_id)
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
    reason: str,
) -> tuple[ExtractionResponse, ExtractionResponse]:
    """Record an owner override as a new immutable extraction response
    version, and as the new authoritative FinalExtraction for the
    publication (superseding whatever was previously authoritative,
    including a reconciled or agreed result)."""
    lock_publication_for_finalization(db, item.publication_id)
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
    answers = normalize_answers(fields, answers)
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

    from app.extraction.final import create_or_replace_final_extraction

    create_or_replace_final_extraction(
        db,
        project_id=item.project_id,
        publication_id=item.publication_id,
        form_version_id=response.form_version_id,
        answers=dict(response.answers),
        resolution_method="override",
        resolved_by_id=actor_id,
        note=reason,
        field_provenance={
            key: {"from": "manual", "responseId": None} for key in response.answers
        },
        contributing_response_ids=[response.id],
        invalidation_reason="manager_override",
    )

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
    return completed_items_with_response(
        db,
        ExtractionWorkItem,
        ExtractionResponse,
        project_id=project_id,
        reviewer_id=reviewer_id,
        completed_status=ExtractionStatus.COMPLETED,
    )


def reopen_for_required_field(db: Session, project_id: str) -> int:
    items = list(
        db.scalars(
            select(ExtractionWorkItem).where(
                ExtractionWorkItem.project_id == project_id,
                ExtractionWorkItem.status == ExtractionStatus.COMPLETED,
            )
        )
    )
    affected_publication_ids = {item.publication_id for item in items}
    for item in items:
        item.status = ExtractionStatus.AVAILABLE
        item.completed_at = None
        item.reserved_until = None
    db.flush()

    from app.extraction.final import invalidate_current_final_extraction

    for publication_id in affected_publication_ids:
        invalidate_current_final_extraction(
            db, publication_id, "form_reopened_for_required_field"
        )
    db.flush()
    return len(items)
