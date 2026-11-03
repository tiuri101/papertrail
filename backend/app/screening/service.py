from __future__ import annotations

import hashlib
from collections import defaultdict
from collections.abc import Iterable
from datetime import timedelta
from typing import Any
from uuid import uuid4

from sqlalchemy import ColumnElement, and_, case, distinct, func, or_, select
from sqlalchemy.orm import Session, joinedload, selectinload

from app.accounts.models import User
from app.api.errors import DomainError, ForbiddenError, NotFoundError
from app.core.time import utcnow
from app.projects.models import (
    STAGE_ORDER as _PROJECT_STAGE_ORDER,
)
from app.projects.models import (
    AllocationMode,
    Criterion,
    Project,
    ProjectMembership,
    ProjectStage,
    ResolutionMethod,
    ScreeningConfig,
    ScreeningStage,
)
from app.projects.service import reviewer_weights, weighted_round_robin_sequence
from app.publications.models import Publication
from app.review_work.eligibility import (
    capability_for_stage,
    require_reviewer_capability_by_id,
)
from app.review_work.finalization import lock_publication_for_finalization
from app.review_work.structural_config import (
    StructuralSettingLockedError,
    work_items_exist,
)
from app.screening.models import (
    ScreeningDecision,
    ScreeningOutcome,
    ScreeningWorkItem,
    WorkItemStatus,
)

RESERVATION_HOURS = 1


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


def screening_work_started(
    db: Session, project_id: str, stage: ScreeningStage
) -> bool:
    """Whether this project stage has generated any screening work item yet.

    The moment the first slot exists, the stage's shape is fixed: slot count
    and assignment mode are baked into rows nothing revisits, so
    :func:`update_screening_config` freezes the structural settings from here
    on. Existence, not submission, is the line -- an unsubmitted slot is just
    as stranded by a mode switch as a submitted one.
    """
    return work_items_exist(
        db,
        ScreeningWorkItem.id,
        ScreeningWorkItem.project_id == project_id,
        ScreeningWorkItem.stage == stage,
    )


def screened_publication_ids(
    db: Session, publication_ids: Iterable[str]
) -> set[str]:
    """Which of these publications carry screening progress -- a reviewer
    decision or a valid final decision, at any stage. That is what is lost
    from the review if the publication is removed or merged away."""
    from app.conflicts.models import FinalDecision

    ids = set(publication_ids)
    if not ids:
        return set()
    decided = set(
        db.scalars(
            select(distinct(ScreeningWorkItem.publication_id))
            .join(
                ScreeningDecision,
                ScreeningDecision.work_item_id == ScreeningWorkItem.id,
            )
            .where(ScreeningWorkItem.publication_id.in_(ids))
        )
    )
    finalized = set(
        db.scalars(
            select(distinct(FinalDecision.publication_id)).where(
                FinalDecision.publication_id.in_(ids),
                FinalDecision.is_valid.is_(True),
            )
        )
    )
    return decided | finalized


def awaiting_duplicate_check_clause() -> ColumnElement[bool]:
    """Publications that must stay out of screening for now: imported after
    duplicate review and not yet checked, or part of an unresolved duplicate
    pair. Either way a reviewer may be about to merge them away."""
    from app.deduplication.models import DuplicateCandidate

    in_unresolved_pair = (
        select(DuplicateCandidate.id)
        .where(
            DuplicateCandidate.status == "unresolved",
            or_(
                DuplicateCandidate.publication_a_id == Publication.id,
                DuplicateCandidate.publication_b_id == Publication.id,
            ),
        )
        .exists()
    )
    return or_(Publication.duplicate_check_pending.is_(True), in_unresolved_pair)


def update_screening_config(
    db: Session,
    project_id: str,
    stage: ScreeningStage,
    *,
    required_reviewers: int,
    allocation_mode: AllocationMode,
    conflict_resolution: ResolutionMethod,
    uncertain_resolution: ResolutionMethod,
) -> ScreeningConfig:
    """Apply a stage's screening configuration, refusing structural changes
    once the stage has work items (see app.review_work.structural_config).

    The resolution policies are deliberately *not* frozen: they only decide
    how already-collected decisions are interpreted, so changing them mid-way
    reinterprets existing decisions rather than orphaning existing work.
    """
    config = get_screening_config(db, project_id, stage)
    if config is None:
        raise NotFoundError("Screening configuration not found")

    structural_changes = {
        "requiredReviewers": config.required_reviewers != required_reviewers,
        "allocationMode": config.allocation_mode != allocation_mode,
    }
    changed = [setting for setting, differs in structural_changes.items() if differs]
    if changed and screening_work_started(db, project_id, stage):
        labels = {
            "requiredReviewers": "the required reviewer count",
            "allocationMode": "the allocation mode",
        }
        raise StructuralSettingLockedError(
            f"Cannot change {labels[changed[0]]} for {stage.value} screening "
            "after work items exist for this stage",
            setting=changed[0],
            stage=stage.value,
        )

    config.required_reviewers = required_reviewers
    config.allocation_mode = allocation_mode
    config.conflict_resolution = conflict_resolution
    config.uncertain_resolution = uncertain_resolution
    db.flush()
    return config


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
    query = select(Publication.id).where(
        Publication.project_id == project.id,
        Publication.is_active.is_(True),
        Publication.merged_into_id.is_(None),
        ~awaiting_duplicate_check_clause(),
    )
    if publication_ids is not None:
        query = query.where(Publication.id.in_(publication_ids))
    publication_id_list = list(db.scalars(query.order_by(Publication.id)))
    # One lookup for every slot that already exists, instead of a SELECT per
    # (publication, slot) inside the loop below. On a project with several
    # thousand publications the per-slot probes were the dominant cost of every
    # "load next publication" fetch, which backfills through here on each call.
    existing_slots: set[tuple[str, int]] = {
        (publication_id, slot_number)
        for publication_id, slot_number in db.execute(
            select(
                ScreeningWorkItem.publication_id, ScreeningWorkItem.slot_number
            ).where(
                ScreeningWorkItem.project_id == project.id,
                ScreeningWorkItem.stage == stage,
            )
        )
    }
    created = 0
    new_items: list[ScreeningWorkItem] = []
    newly_eligible_publication_ids: set[str] = set()
    # In claim mode, slots are left unassigned for reviewers to pick up themselves
    # (see claim_next_work_item), so no assignment sequence is needed. Otherwise,
    # slots are pre-assigned round-robin, weighted by each reviewer's configured
    # workload share.
    assignment_sequence: list[str] = (
        []
        if config.allocation_mode == AllocationMode.CLAIM
        else weighted_round_robin_sequence(
            reviewers,
            reviewer_weights(db, project.id, reviewers),
            len(publication_id_list) * config.required_reviewers,
        )
    )
    assignment_position = 0
    for publication_id in publication_id_list:
        rank = rank_for(project, publication_id, stage)
        for slot in range(config.required_reviewers):
            if (publication_id, slot + 1) in existing_slots:
                continue
            if config.allocation_mode == AllocationMode.CLAIM:
                assigned_reviewer_id = None
            else:
                assigned_reviewer_id = assignment_sequence[assignment_position]
                assignment_position += 1
            new_items.append(
                ScreeningWorkItem(
                    project_id=project.id,
                    publication_id=publication_id,
                    stage=stage,
                    slot_number=slot + 1,
                    assigned_reviewer_id=assigned_reviewer_id,
                    random_rank=rank,
                )
            )
            created += 1
            newly_eligible_publication_ids.add(publication_id)
    db.add_all(new_items)
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


def has_publications_without_work_items(
    db: Session, project_id: str, stage: ScreeningStage
) -> bool:
    """Whether any active, non-merged publication is missing a work item for
    this stage -- i.e. whether a `create_screening_work_items` backfill would
    actually do anything.

    `next_item` calls the backfill on every fetch to catch publications added
    after the one-time creation at duplicate-review completion. That backfill
    scans every publication in the project, so on a large project it dominated
    the request even when there was nothing to create. This is a single
    LIMIT 1 anti-join that lets the hot path skip the backfill entirely in the
    overwhelmingly common case where every publication already has its slots.
    """
    work_item_exists = (
        select(ScreeningWorkItem.id)
        .where(
            ScreeningWorkItem.publication_id == Publication.id,
            ScreeningWorkItem.stage == stage,
        )
        .exists()
    )
    return (
        db.scalar(
            select(Publication.id)
            .where(
                Publication.project_id == project_id,
                Publication.is_active.is_(True),
                Publication.merged_into_id.is_(None),
                ~work_item_exists,
            )
            .limit(1)
        )
        is not None
    )


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

    In claim mode, orphaned items are released back to the open pool (unassigned)
    instead of being pushed onto a specific reviewer, matching how claim mode
    hands out work everywhere else.
    """
    eligible = eligible_reviewer_ids(db, project_id, stage)
    if not eligible:
        return 0
    orphan_filters = (
        ScreeningWorkItem.project_id == project_id,
        ScreeningWorkItem.stage == stage,
        ScreeningWorkItem.status != WorkItemStatus.SUBMITTED,
        ScreeningWorkItem.assigned_reviewer_id.is_not(None),
        ScreeningWorkItem.assigned_reviewer_id.not_in(eligible),
    )
    # next_item runs this defensively on every fetch. Probe first so the common
    # case (nobody lost eligibility since work items were created) costs one
    # LIMIT 1 lookup instead of materialising and rank-sorting the whole stage.
    if db.scalar(select(ScreeningWorkItem.id).where(*orphan_filters).limit(1)) is None:
        return 0
    config = get_screening_config(db, project_id, stage)
    claim_mode = config is not None and config.allocation_mode == AllocationMode.CLAIM
    orphaned = list(
        db.scalars(
            select(ScreeningWorkItem)
            .where(*orphan_filters)
            .order_by(ScreeningWorkItem.random_rank)
        )
    )
    for index, item in enumerate(orphaned):
        item.assigned_reviewer_id = (
            None if claim_mode else eligible[index % len(eligible)]
        )
        if item.status == WorkItemStatus.RESERVED:
            item.status = WorkItemStatus.AVAILABLE
            item.reserved_by_id = None
            item.reserved_until = None
    db.flush()
    return len(orphaned)


def rebalance_pending_work_items(
    db: Session, project_id: str, stage: ScreeningStage
) -> int:
    """Spread a stage's not-yet-claimed (AVAILABLE) work items evenly across all
    currently eligible reviewers, so someone just granted stage access picks up a
    fair share of the backlog instead of it staying stuck on whoever was eligible
    when the stage's items were originally created.

    Reserved and submitted items are left untouched -- work already claimed or
    decided shouldn't move. A reviewer already committed to a publication (via a
    reserved or submitted item for one of its other slots) is never handed that
    publication's remaining slots, so dual screening stays independent.

    A no-op when the stage is in claim mode: AVAILABLE items there are an
    intentionally open pool for reviewers to pick from, not a backlog to
    pre-assign.
    """
    config = get_screening_config(db, project_id, stage)
    if config is None or config.allocation_mode == AllocationMode.CLAIM:
        return 0
    eligible = eligible_reviewer_ids(db, project_id, stage)
    if not eligible:
        return 0
    weights = reviewer_weights(db, project_id, eligible)
    items = list(
        db.scalars(
            select(ScreeningWorkItem)
            .where(
                ScreeningWorkItem.project_id == project_id,
                ScreeningWorkItem.stage == stage,
            )
            .order_by(ScreeningWorkItem.random_rank, ScreeningWorkItem.slot_number)
        )
    )
    load = {reviewer_id: 0 for reviewer_id in eligible}
    committed: dict[str, set[str]] = defaultdict(set)
    pending: list[ScreeningWorkItem] = []
    for item in items:
        if item.status == WorkItemStatus.AVAILABLE:
            pending.append(item)
            continue
        if item.assigned_reviewer_id:
            committed[item.publication_id].add(item.assigned_reviewer_id)
        if item.assigned_reviewer_id in load:
            load[item.assigned_reviewer_id] += 1

    reassigned = 0
    for item in pending:
        taken = committed[item.publication_id]
        candidates = sorted(
            (r for r in eligible if r not in taken),
            key=lambda r: (load[r] / weights.get(r, 1.0), r),
        )
        if not candidates:
            continue
        chosen = candidates[0]
        if item.assigned_reviewer_id != chosen:
            item.assigned_reviewer_id = chosen
            reassigned += 1
        load[chosen] += 1
        committed[item.publication_id].add(chosen)
    db.flush()
    return reassigned


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


def _llm_ready_rank(db: Session, project_id: str, stage: ScreeningStage) -> Any:
    """Order key sorting work items whose publication has a completed LLM
    screening suggestion ahead of ones without, so reviewers see LLM-assisted
    papers first. Returns None when LLM assistance is disabled for this stage,
    in which case ordering is left untouched.

    This is a soft ordering hint, not a correctness gate -- the result endpoint
    still enforces the independent-decision reveal gate. It asks "does a
    completed run exist" (a plain EXISTS, backed by ix_llm_runs_pub_task_status)
    rather than "is the *latest* run completed" (which needed a per-row ordered
    subquery). A completed run followed by a stale/failed re-run therefore still
    counts as ready, which is fine for queue ordering.
    """
    from app.llm.models import LlmExtractionRun, LlmTaskType, ProcessingStatus
    from app.llm.task_service import feature_enabled

    task_type = {
        ScreeningStage.TITLE_ABSTRACT: LlmTaskType.TITLE_ABSTRACT_SCREENING,
        ScreeningStage.FULL_TEXT: LlmTaskType.FULL_TEXT_SCREENING,
    }[stage]
    if not feature_enabled(db, project_id, task_type):
        return None
    completed_run_exists = (
        select(LlmExtractionRun.id)
        .where(
            LlmExtractionRun.publication_id == ScreeningWorkItem.publication_id,
            LlmExtractionRun.task_type == task_type,
            LlmExtractionRun.status == ProcessingStatus.COMPLETED,
        )
        .correlate(ScreeningWorkItem)
        .exists()
    )
    return case((completed_run_exists, 0), else_=1)


def claim_next_work_item(
    db: Session,
    project_id: str,
    stage: ScreeningStage,
    reviewer_id: str,
    publication_id: str | None = None,
    excluded_item_ids: set[str] | None = None,
) -> ScreeningWorkItem | None:
    require_reviewer_capability_by_id(
        db, project_id, reviewer_id, capability_for_stage(stage)
    )
    now = utcnow()
    excluded_item_ids = excluded_item_ids or set()
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
    if excluded_item_ids:
        reserved_filters.append(ScreeningWorkItem.id.not_in(excluded_item_ids))
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
    config = get_screening_config(db, project_id, stage)
    claim_mode = config is not None and config.allocation_mode == AllocationMode.CLAIM
    # In claim mode, slots start unassigned and any eligible reviewer may pick one
    # up from the shared pool. Otherwise, a reviewer only ever sees slots that
    # were pre-assigned to them.
    assignment_filter = (
        ScreeningWorkItem.assigned_reviewer_id.is_(None)
        if claim_mode
        else ScreeningWorkItem.assigned_reviewer_id == reviewer_id
    )
    filters = [
        ScreeningWorkItem.project_id == project_id,
        ScreeningWorkItem.stage == stage,
        assignment_filter,
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
    if excluded_item_ids:
        filters.append(ScreeningWorkItem.id.not_in(excluded_item_ids))
    order = [ScreeningWorkItem.random_rank, ScreeningWorkItem.slot_number]
    llm_ready_rank = _llm_ready_rank(db, project_id, stage)
    if llm_ready_rank is not None:
        order.insert(0, llm_ready_rank)
    query = select(ScreeningWorkItem).where(*filters).order_by(*order).limit(1)
    if db.bind is not None and db.bind.dialect.name == "postgresql":
        query = query.with_for_update(skip_locked=True)
    item = db.scalar(query)
    if item is None:
        return None
    if claim_mode:
        item.assigned_reviewer_id = reviewer_id
    item.status = WorkItemStatus.RESERVED
    item.reserved_by_id = reviewer_id
    item.reserved_until = now + timedelta(hours=RESERVATION_HOURS)
    db.flush()
    return item


def release_work_item(db: Session, item: ScreeningWorkItem, reviewer_id: str) -> None:
    """Return a reserved item to the pool.

    In claim mode, releasing must also clear `assigned_reviewer_id` back to
    None. Otherwise the item would stay pinned to this reviewer while
    `claim_next_work_item` only ever offers unassigned items to claim,
    stranding it: invisible in everyone's queue (including this reviewer's)
    yet still counted in their `remaining` total by
    `remaining_claimable_publications`, which only checks `assigned_reviewer_id`.
    """
    require_reviewer_capability_by_id(
        db, item.project_id, reviewer_id, capability_for_stage(item.stage)
    )
    if item.reserved_by_id != reviewer_id:
        raise ForbiddenError("This work item is not reserved by the current reviewer")
    config = get_screening_config(db, item.project_id, item.stage)
    claim_mode = config is not None and config.allocation_mode == AllocationMode.CLAIM
    item.status = WorkItemStatus.AVAILABLE
    item.reserved_by_id = None
    item.reserved_until = None
    if claim_mode:
        item.assigned_reviewer_id = None


def save_draft(
    db: Session, item: ScreeningWorkItem, reviewer_id: str, draft: dict[str, Any]
) -> None:
    require_reviewer_capability_by_id(
        db, item.project_id, reviewer_id, capability_for_stage(item.stage)
    )
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
    require_reviewer_capability_by_id(
        db, item.project_id, reviewer_id, capability_for_stage(item.stage)
    )
    if item.assigned_reviewer_id != reviewer_id:
        raise ForbiddenError("This work item is assigned to another reviewer")
    # Everything from here to the caller's commit -- writing this reviewer's
    # decision, and the refresh_automatic_final_decision that reads every
    # reviewer's decision back to see whether quorum is now reached -- has to
    # be serialized per publication, or two reviewers submitting the last two
    # slots concurrently each see only their own decision and neither
    # finalizes.
    lock_publication_for_finalization(db, item.publication_id)
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


def override_decision(
    db: Session,
    item: ScreeningWorkItem,
    actor_id: str,
    outcome: str | ScreeningOutcome,
    criteria_answers: dict[str, bool],
    notes: str | None,
) -> tuple[ScreeningDecision, ScreeningDecision]:
    lock_publication_for_finalization(db, item.publication_id)
    current = db.scalar(
        select(ScreeningDecision).where(
            ScreeningDecision.work_item_id == item.id,
            ScreeningDecision.is_current.is_(True),
        )
    )
    if current is None:
        raise DomainError(
            "A submitted screening response is required before overriding it"
        )
    if set(criteria_answers) != set(current.criteria_answers) or any(
        not isinstance(value, bool) for value in criteria_answers.values()
    ):
        raise DomainError(
            "Every criterion in the submitted screening response must be explicitly answered"
        )

    current.is_current = False
    decision = ScreeningDecision(
        work_item_id=item.id,
        reviewer_id=actor_id,
        outcome=ScreeningOutcome(outcome),
        criteria_answers=criteria_answers,
        notes=notes,
        version=current.version + 1,
        is_current=True,
    )
    db.add(decision)

    from app.conflicts.service import invalidate_final_decisions

    invalidate_final_decisions(db, item.publication_id, item.stage)
    db.flush()
    return decision, current


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


def remaining_claimable_publications(
    db: Session, project_id: str, stage: ScreeningStage, reviewer_id: str
) -> int:
    """How many publications this reviewer could still screen for a stage in claim
    mode: those already reserved by them plus those still open in the shared
    pool, excluding publications they've already submitted a decision for."""
    already_submitted = select(ScreeningWorkItem.publication_id).where(
        ScreeningWorkItem.project_id == project_id,
        ScreeningWorkItem.stage == stage,
        ScreeningWorkItem.assigned_reviewer_id == reviewer_id,
        ScreeningWorkItem.status == WorkItemStatus.SUBMITTED,
    )
    return (
        db.scalar(
            select(func.count(func.distinct(ScreeningWorkItem.publication_id)))
            .select_from(ScreeningWorkItem)
            .where(
                ScreeningWorkItem.project_id == project_id,
                ScreeningWorkItem.stage == stage,
                ScreeningWorkItem.status != WorkItemStatus.SUBMITTED,
                or_(
                    ScreeningWorkItem.assigned_reviewer_id == reviewer_id,
                    ScreeningWorkItem.assigned_reviewer_id.is_(None),
                ),
                ~ScreeningWorkItem.publication_id.in_(already_submitted),
            )
        )
        or 0
    )


def my_progress(
    db: Session, project_id: str, stage: ScreeningStage, reviewer_id: str
) -> dict[str, int | bool]:
    """How many work items this reviewer has been assigned for a stage, and how
    many of those they've already submitted a decision for. In claim mode, work
    items start unassigned, so also report how many publications are still
    available for this reviewer to pick up."""
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
    config = get_screening_config(db, project_id, stage)
    claim_mode = config is not None and config.allocation_mode == AllocationMode.CLAIM
    remaining = (
        remaining_claimable_publications(db, project_id, stage, reviewer_id)
        if claim_mode
        else 0
    )
    return {
        "assigned": assigned,
        "completed": completed,
        "remaining": remaining,
        "claim_mode": claim_mode,
    }


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
