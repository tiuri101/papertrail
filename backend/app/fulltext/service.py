from __future__ import annotations

from datetime import UTC, datetime, timedelta

from sqlalchemy import case, func, or_, select
from sqlalchemy.orm import Session

from app.api.errors import DomainError, ForbiddenError
from app.conflicts.service import refresh_automatic_final_decision, valid_final_decision
from app.core.time import utcnow
from app.fulltext.models import FullTextRetrieval, PublicationDocument, RetrievalStatus
from app.jobs.service import enqueue_job
from app.projects.models import Project, ProjectStage, ScreeningStage
from app.screening.cohorts import decided_ids_for_stage, title_abstract_included_ids
from app.screening.models import ScreeningDecision, ScreeningWorkItem
from app.screening.service import (
    claim_next_work_item,
    create_screening_work_items,
    submit_decision,
)

RESERVATION_HOURS = 24

# A retrieval remains claimable work until it reaches one of these; everything
# else (available/not_found/inaccessible) is resolved and drops out of the queue.
CLAIMABLE_STATUSES = (RetrievalStatus.NOT_YET_SOUGHT, RetrievalStatus.REQUESTED)


def ensure_full_text_retrieval(
    db: Session, project: Project, publication_id: str
) -> FullTextRetrieval | None:
    """Create the FullTextRetrieval row for a title/abstract-included
    publication if one doesn't already exist. Returns the newly created row,
    or None if it already existed (idempotent, so callers can invoke this
    both from the batch stage transition and immediately on inclusion)."""
    existing = db.scalar(
        select(FullTextRetrieval.id).where(
            FullTextRetrieval.publication_id == publication_id
        )
    )
    if existing:
        return None
    has_pdf = db.scalar(
        select(PublicationDocument.id).where(
            PublicationDocument.publication_id == publication_id,
            PublicationDocument.is_active.is_(True),
        )
    )
    retrieval = FullTextRetrieval(
        project_id=project.id,
        publication_id=publication_id,
        status=(
            RetrievalStatus.AVAILABLE if has_pdf else RetrievalStatus.NOT_YET_SOUGHT
        ),
    )
    db.add(retrieval)
    db.flush()
    return retrieval


def initialize_full_text_stage(db: Session, project: Project) -> int:
    created = 0
    available_publication_ids: list[str] = []
    for publication_id in title_abstract_included_ids(db, project.id):
        retrieval = ensure_full_text_retrieval(db, project, publication_id)
        if retrieval is None:
            continue
        if retrieval.status == RetrievalStatus.AVAILABLE:
            available_publication_ids.append(publication_id)
        created += 1
    if available_publication_ids:
        create_screening_work_items(
            db,
            project,
            ScreeningStage.FULL_TEXT,
            publication_ids=available_publication_ids,
        )
    return created


def claim_next_retrieval(
    db: Session,
    project_id: str,
    user_id: str,
    excluded_retrieval_ids: set[str] | None = None,
) -> FullTextRetrieval | None:
    """Claim the next paper needing full-text retrieval for this reviewer.

    Papers aren't distributed up front -- one is reserved only once a reviewer
    actually asks for it, so no more than one reviewer is ever looking at the
    same paper at a time. A reviewer's own in-progress ("requested") claim is
    only offered back to them once every never-touched paper has been claimed,
    so a follow-up on an ILL request doesn't block them from picking up fresh
    work.
    """
    now = utcnow()
    filters = [
        FullTextRetrieval.project_id == project_id,
        FullTextRetrieval.status.in_(CLAIMABLE_STATUSES),
        or_(
            FullTextRetrieval.claimed_by_id.is_(None),
            FullTextRetrieval.claimed_until < now,
            FullTextRetrieval.claimed_by_id == user_id,
        ),
    ]
    if excluded_retrieval_ids:
        filters.append(FullTextRetrieval.id.not_in(excluded_retrieval_ids))
    priority = case(
        (FullTextRetrieval.status == RetrievalStatus.NOT_YET_SOUGHT, 0), else_=1
    )
    query = (
        select(FullTextRetrieval)
        .where(*filters)
        .order_by(priority, FullTextRetrieval.created_at)
        .limit(1)
    )
    if db.bind is not None and db.bind.dialect.name == "postgresql":
        query = query.with_for_update(skip_locked=True)
    retrieval = db.scalar(query)
    if retrieval is None:
        return None
    retrieval.claimed_by_id = user_id
    retrieval.claimed_until = now + timedelta(hours=RESERVATION_HOURS)
    db.flush()
    return retrieval


def release_retrieval_claim(retrieval: FullTextRetrieval, user_id: str) -> None:
    if retrieval.claimed_by_id != user_id:
        raise ForbiddenError("This publication is not claimed by the current reviewer")
    retrieval.claimed_by_id = None
    retrieval.claimed_until = None


def ensure_retrieval_claim(retrieval: FullTextRetrieval, user_id: str) -> None:
    """Reject a status update from someone other than whoever actively holds
    the claim. Unclaimed and expired-claim retrievals are left open -- e.g.
    for a manager updating a record no one has picked up yet."""
    if (
        retrieval.claimed_by_id is not None
        and retrieval.claimed_by_id != user_id
        and retrieval.claimed_until is not None
        and retrieval.claimed_until >= utcnow()
    ):
        raise ForbiddenError(
            "This publication is currently claimed by another reviewer"
        )


def retrieval_progress(db: Session, project_id: str) -> dict[str, int]:
    total = (
        db.scalar(
            select(func.count())
            .select_from(FullTextRetrieval)
            .where(FullTextRetrieval.project_id == project_id)
        )
        or 0
    )
    addressed = (
        db.scalar(
            select(func.count())
            .select_from(FullTextRetrieval)
            .where(
                FullTextRetrieval.project_id == project_id,
                FullTextRetrieval.status != RetrievalStatus.NOT_YET_SOUGHT,
            )
        )
        or 0
    )
    return {"total": total, "addressed": addressed}


def set_retrieval_status(
    db: Session,
    retrieval: FullTextRetrieval,
    status: RetrievalStatus,
    *,
    note: str | None = None,
    user_id: str | None = None,
) -> None:
    retrieval.status = status
    retrieval.note = note
    retrieval.updated_by_id = user_id
    if status == RetrievalStatus.REQUESTED and user_id is not None:
        retrieval.claimed_by_id = user_id
        retrieval.claimed_until = utcnow() + timedelta(hours=RESERVATION_HOURS)
    else:
        retrieval.claimed_by_id = None
        retrieval.claimed_until = None
    if status == RetrievalStatus.AVAILABLE:
        project = db.get(Project, retrieval.project_id)
        assert project is not None
        create_screening_work_items(
            db,
            project,
            ScreeningStage.FULL_TEXT,
            publication_ids=[retrieval.publication_id],
        )
    elif status in {RetrievalStatus.NOT_FOUND, RetrievalStatus.INACCESSIBLE}:
        items = list(
            db.scalars(
                select(ScreeningWorkItem).where(
                    ScreeningWorkItem.publication_id == retrieval.publication_id,
                    ScreeningWorkItem.stage == ScreeningStage.FULL_TEXT,
                    ScreeningWorkItem.status != "submitted",
                )
            )
        )
        for item in items:
            db.delete(item)
    db.flush()


def resolve_retrieval(
    db: Session,
    retrieval: FullTextRetrieval,
    status: RetrievalStatus,
    *,
    note: str | None = None,
    user_id: str,
    decision_outcome: str | None = None,
    decision_criteria_answers: dict[str, bool] | None = None,
    decision_notes: str | None = None,
) -> ScreeningDecision | None:
    """Save a retrieval status and, in the same action, submit the reviewer's
    full-text screening decision if the report was just marked available.
    Returns None when no decision was submitted (status isn't available, or
    the current user has no screening work item for this publication)."""
    ensure_retrieval_claim(retrieval, user_id)
    set_retrieval_status(db, retrieval, status, note=note, user_id=user_id)
    if decision_outcome is None:
        return None
    if status != RetrievalStatus.AVAILABLE:
        raise DomainError(
            "A screening decision can only be submitted when the full text is available"
        )
    item = claim_next_work_item(
        db,
        retrieval.project_id,
        ScreeningStage.FULL_TEXT,
        user_id,
        publication_id=retrieval.publication_id,
    )
    if item is None:
        return None
    decision = submit_decision(
        db,
        item,
        user_id,
        decision_outcome,
        decision_criteria_answers or {},
        decision_notes,
    )
    refresh_automatic_final_decision(
        db, retrieval.publication_id, ScreeningStage.FULL_TEXT
    )
    return decision


def full_text_work_completed(db: Session, project: Project) -> bool:
    """Read-only check for all retrieval and full-text screening work.

    Scoped to publications *currently* included at title/abstract. A
    publication's inclusion can be reversed after its FullTextRetrieval row
    was already created; that stray row must not block completeness forever
    -- it simply stops being relevant once the publication is no longer
    title/abstract-included.
    """
    expected = set(title_abstract_included_ids(db, project.id))
    retrievals = list(
        db.scalars(
            select(FullTextRetrieval).where(
                FullTextRetrieval.project_id == project.id,
                FullTextRetrieval.publication_id.in_(expected),
            )
        )
    )
    if {item.publication_id for item in retrievals} != expected:
        return False
    for retrieval in retrievals:
        if retrieval.status in {
            RetrievalStatus.NOT_YET_SOUGHT,
            RetrievalStatus.REQUESTED,
        }:
            return False
        if retrieval.status == RetrievalStatus.AVAILABLE:
            final = valid_final_decision(
                db, retrieval.publication_id, ScreeningStage.FULL_TEXT
            )
            if final is None:
                return False
    return True


def full_text_screening_remaining(db: Session, project_id: str) -> int:
    """Count publications with an available PDF but no final full-text
    decision yet -- work still outstanding regardless of whether the project
    as a whole has already moved past the full-text stage."""
    decided_ids = set(decided_ids_for_stage(db, project_id, ScreeningStage.FULL_TEXT))
    available_ids = set(
        db.scalars(
            select(FullTextRetrieval.publication_id).where(
                FullTextRetrieval.project_id == project_id,
                FullTextRetrieval.status == RetrievalStatus.AVAILABLE,
            )
        )
    )
    return len(available_ids - decided_ids)


def transition_if_full_text_complete(db: Session, project: Project) -> bool:
    # Late revisions are reconciled per publication and must not rewind an
    # extraction or completed project back into the full-text transition.
    if project.stage != ProjectStage.FULL_TEXT:
        return False
    if not full_text_work_completed(db, project):
        return False

    from app.extraction.service import initialize_extraction, project_form

    if project_form(db, project.id) is None:
        return False

    project.stage = ProjectStage.EXTRACTION

    initialize_extraction(db, project)
    try:
        from app.quality.service import initialize_quality

        initialize_quality(db, project)
    except DomainError:
        raise

    from app.notifications.service import queue_project_stage_completed_emails

    queue_project_stage_completed_emails(
        db, project, ProjectStage.FULL_TEXT, datetime.now(UTC)
    )
    enqueue_job(
        db,
        "generate_stage_analysis",
        {"stage": "full_text_screening"},
        project_id=project.id,
        created_by_id=None,
        priority=5,
    )
    db.flush()
    return True
