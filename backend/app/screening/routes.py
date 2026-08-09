from __future__ import annotations

import contextlib
from typing import Any

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.accounts.dependencies import get_current_user, require_csrf
from app.accounts.models import User, UserSession
from app.api.errors import DomainError, NotFoundError
from app.audit.service import record_audit
from app.db.session import get_db
from app.projects.dependencies import (
    require_project_manager,
    require_project_manager_csrf,
)
from app.projects.models import Criterion, ScreeningStage
from app.projects.service import get_project, require_project_access
from app.publications.models import Publication
from app.screening.models import ScreeningDecision, ScreeningWorkItem, WorkItemStatus
from app.screening.schemas import (
    AssignmentItem,
    AssignmentsPage,
    BulkReassignRequest,
    BulkReassignResponse,
    DecisionResponse,
    DecisionSubmit,
    DraftUpdate,
    MyDecisionsResponse,
    MyProgressResponse,
    ReassignRequest,
    WorkItemResponse,
)
from app.screening.service import (
    bulk_reassign_work_items,
    claim_next_work_item,
    create_screening_work_items,
    current_decisions,
    my_progress,
    my_submitted_work_items,
    reassign_work_item,
    reassign_work_items_from_ineligible_reviewers,
    release_work_item,
    save_draft,
    stage_completed,
    submit_decision,
)

router = APIRouter(tags=["screening"])


def work_item_payload(db: Session, item: ScreeningWorkItem) -> dict[str, Any]:
    publication = db.get(Publication, item.publication_id)
    criteria = list(
        db.scalars(
            select(Criterion)
            .where(
                Criterion.project_id == item.project_id, Criterion.is_active.is_(True)
            )
            .order_by(Criterion.position)
        )
    )
    return {
        "id": item.id,
        "project_id": item.project_id,
        "stage": item.stage.value,
        "slot_number": item.slot_number,
        "reserved_until": (
            item.reserved_until.isoformat() if item.reserved_until else None
        ),
        "draft": item.draft,
        "publication": publication,
        "criteria": criteria,
    }


@router.post(
    "/projects/{project_id}/screening/{stage}/next",
    response_model=WorkItemResponse | None,
)
def next_item(
    project_id: str,
    stage: ScreeningStage,
    session: UserSession = Depends(require_csrf),
    db: Session = Depends(get_db),
) -> dict[str, Any] | None:
    project = require_project_access(db, project_id, session.user)
    if stage == ScreeningStage.TITLE_ABSTRACT:
        # Publications added after duplicate review completes (a manual add, or a
        # second import batch) never went through the one-time work-item creation
        # that runs at that transition. Backfilling here -- idempotent, since
        # existing work items are left alone -- keeps any such publication from
        # silently sitting invisible to reviewers instead of just leaving it stuck.
        with contextlib.suppress(DomainError):
            create_screening_work_items(db, project, ScreeningStage.TITLE_ABSTRACT)
    # A reviewer removed (or had this stage's permission revoked) after work items
    # were assigned would otherwise leave those items stuck on someone who can no
    # longer claim them, and invisible to everyone else. Redistribute defensively
    # on every fetch so this can't leave a project permanently short a publication.
    reassign_work_items_from_ineligible_reviewers(db, project_id, stage)
    item = claim_next_work_item(db, project_id, stage, session.user.id)
    if item is not None:
        if stage == ScreeningStage.TITLE_ABSTRACT:
            from app.llm.task_service import queue_title_abstract_suggestion

            queue_title_abstract_suggestion(
                db, item.publication_id, created_by_id=session.user.id, priority=10
            )
        else:
            from app.llm.task_service import queue_full_text_assistance

            queue_full_text_assistance(
                db, item.publication_id, created_by_id=session.user.id, priority=0
            )
    db.commit()
    return work_item_payload(db, item) if item else None


@router.put("/projects/{project_id}/screening/work-items/{item_id}/draft")
def update_draft(
    project_id: str,
    item_id: str,
    payload: DraftUpdate,
    session: UserSession = Depends(require_csrf),
    db: Session = Depends(get_db),
) -> dict[str, str]:
    item = db.get(ScreeningWorkItem, item_id)
    if item is None or item.project_id != project_id:
        raise NotFoundError("Screening work item not found")
    save_draft(item, session.user.id, payload.draft)
    db.commit()
    return {"status": "saved"}


@router.post("/projects/{project_id}/screening/work-items/{item_id}/release")
def release_item(
    project_id: str,
    item_id: str,
    session: UserSession = Depends(require_csrf),
    db: Session = Depends(get_db),
) -> dict[str, str]:
    item = db.get(ScreeningWorkItem, item_id)
    if item is None or item.project_id != project_id:
        raise NotFoundError("Screening work item not found")
    release_work_item(item, session.user.id)
    db.commit()
    return {"status": "released"}


@router.post(
    "/projects/{project_id}/screening/work-items/{item_id}/decision",
    response_model=DecisionResponse,
)
def decide(
    project_id: str,
    item_id: str,
    payload: DecisionSubmit,
    session: UserSession = Depends(require_csrf),
    db: Session = Depends(get_db),
) -> ScreeningDecision:
    item = db.get(ScreeningWorkItem, item_id)
    if item is None or item.project_id != project_id:
        raise NotFoundError("Screening work item not found")
    project = get_project(db, project_id)
    was_stage_completed = stage_completed(project, item.stage)
    decision = submit_decision(
        db,
        item,
        session.user.id,
        payload.outcome,
        payload.criteria_answers,
        payload.notes,
    )
    from app.conflicts.service import (
        refresh_automatic_final_decision,
        transition_if_screening_complete,
    )

    refresh_automatic_final_decision(db, item.publication_id, item.stage)
    transition_if_screening_complete(db, project, item.stage)
    record_audit(
        db,
        action="screening.decision_submitted",
        entity_type="screening_decision",
        entity_id=decision.id,
        project_id=project_id,
        actor_id=session.user.id,
        summary=(
            f"Submitted {item.stage.value} screening decision"
            if decision.version == 1
            else f"Revised {item.stage.value} screening decision"
            + (" after stage completion" if was_stage_completed else "")
        ),
        metadata={
            "outcome": decision.outcome.value,
            "version": decision.version,
            "criteriaAnswers": decision.criteria_answers,
            "revisedAfterStageCompletion": was_stage_completed,
        },
    )
    db.commit()
    return decision


@router.get(
    "/projects/{project_id}/screening/{stage}/publications/{publication_id}/decisions",
    response_model=list[DecisionResponse],
)
def revealed_decisions(
    project_id: str,
    stage: ScreeningStage,
    publication_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[ScreeningDecision]:
    require_project_access(db, project_id, user)
    publication = db.get(Publication, publication_id)
    if publication is None or publication.project_id != project_id:
        raise NotFoundError("Publication not found")
    return current_decisions(db, publication_id, stage)


@router.get(
    "/projects/{project_id}/screening/{stage}/my-decisions",
    response_model=MyDecisionsResponse,
)
def my_decisions(
    project_id: str,
    stage: ScreeningStage,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    project = require_project_access(db, project_id, user)
    items = my_submitted_work_items(db, project_id, stage, user.id)
    criteria = list(
        db.scalars(
            select(Criterion)
            .where(Criterion.project_id == project_id, Criterion.is_active.is_(True))
            .order_by(Criterion.position)
        )
    )
    payload_items = []
    for item in items:
        current = next((d for d in item.decisions if d.is_current), None)
        if current is None:
            continue
        payload_items.append(
            {
                "work_item_id": item.id,
                "submitted_at": (
                    item.submitted_at.isoformat() if item.submitted_at else None
                ),
                "publication": db.get(Publication, item.publication_id),
                "decision": current,
            }
        )
    return {
        "stage_completed": stage_completed(project, stage),
        "criteria": criteria,
        "items": payload_items,
    }


@router.get(
    "/projects/{project_id}/screening/{stage}/progress",
    response_model=MyProgressResponse,
)
def my_progress_endpoint(
    project_id: str,
    stage: ScreeningStage,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, int]:
    require_project_access(db, project_id, user)
    return my_progress(db, project_id, stage, user.id)


ASSIGNMENT_SORT_COLUMNS = {
    "publicationTitle": Publication.title,
    "status": ScreeningWorkItem.status,
    "assignedReviewerName": User.display_name,
    "slotNumber": ScreeningWorkItem.slot_number,
}


def assignment_filters(
    project_id: str,
    stage: ScreeningStage,
    search: str | None,
    status: WorkItemStatus | None,
    reviewer_id: str | None,
) -> list[Any]:
    filters: list[Any] = [
        ScreeningWorkItem.project_id == project_id,
        ScreeningWorkItem.stage == stage,
    ]
    if search:
        filters.append(Publication.title.ilike(f"%{search}%"))
    if status is not None:
        filters.append(ScreeningWorkItem.status == status)
    if reviewer_id == "unassigned":
        filters.append(ScreeningWorkItem.assigned_reviewer_id.is_(None))
    elif reviewer_id is not None:
        filters.append(ScreeningWorkItem.assigned_reviewer_id == reviewer_id)
    return filters


@router.get(
    "/projects/{project_id}/screening/{stage}/assignments",
    response_model=AssignmentsPage,
)
def list_assignments(
    project_id: str,
    stage: ScreeningStage,
    search: str | None = Query(default=None),
    status: WorkItemStatus | None = Query(default=None),
    reviewer_id: str | None = Query(default=None, alias="reviewerId"),
    sort: str = Query(default="publicationTitle"),
    order: str = Query(default="asc"),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=200, alias="pageSize"),
    _: User = Depends(require_project_manager),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    get_project(db, project_id)
    filters = assignment_filters(project_id, stage, search, status, reviewer_id)

    joined = (
        select(ScreeningWorkItem, Publication.title, User.display_name)
        .join(Publication, Publication.id == ScreeningWorkItem.publication_id)
        .outerjoin(User, User.id == ScreeningWorkItem.assigned_reviewer_id)
        .where(*filters)
    )
    total = (
        db.scalar(
            select(func.count()).select_from(
                joined.with_only_columns(ScreeningWorkItem.id).subquery()
            )
        )
        or 0
    )
    reassignable_total = (
        db.scalar(
            select(func.count()).select_from(
                joined.where(ScreeningWorkItem.status != WorkItemStatus.SUBMITTED)
                .with_only_columns(ScreeningWorkItem.id)
                .subquery()
            )
        )
        or 0
    )

    sort_column = ASSIGNMENT_SORT_COLUMNS.get(sort, Publication.title)
    direction = sort_column.desc() if order == "desc" else sort_column.asc()
    # A stable final tiebreaker keeps row order deterministic across pages --
    # without it, ties in the chosen sort column can shuffle between requests
    # and the same row could show up twice, or not at all, across pages.
    rows = db.execute(
        joined.order_by(direction, ScreeningWorkItem.id)
        .limit(page_size)
        .offset((page - 1) * page_size)
    ).all()

    items = [
        {
            "id": item.id,
            "publication_id": item.publication_id,
            "publication_title": title,
            "slot_number": item.slot_number,
            "status": item.status,
            "assigned_reviewer_id": item.assigned_reviewer_id,
            "assigned_reviewer_name": display_name,
        }
        for item, title, display_name in rows
    ]
    return {
        "items": items,
        "total": total,
        "reassignable_total": reassignable_total,
        "page": page,
        "page_size": page_size,
    }


@router.patch(
    "/projects/{project_id}/screening/{stage}/assignments/reassign",
    response_model=BulkReassignResponse,
)
def bulk_reassign_assignments(
    project_id: str,
    stage: ScreeningStage,
    payload: BulkReassignRequest,
    admin: User = Depends(require_project_manager_csrf),
    db: Session = Depends(get_db),
) -> dict[str, int]:
    get_project(db, project_id)
    if payload.select_all_filtered:
        try:
            selected_status = (
                WorkItemStatus(payload.status) if payload.status is not None else None
            )
        except ValueError as exc:
            raise DomainError("Invalid assignment status filter") from exc
        filters = assignment_filters(
            project_id,
            stage,
            payload.search,
            selected_status,
            payload.filter_reviewer_id,
        )
        query = (
            select(ScreeningWorkItem)
            .join(Publication, Publication.id == ScreeningWorkItem.publication_id)
            .where(*filters, ScreeningWorkItem.status != WorkItemStatus.SUBMITTED)
        )
        if payload.excluded_work_item_ids:
            query = query.where(
                ScreeningWorkItem.id.not_in(payload.excluded_work_item_ids)
            )
        items = list(db.scalars(query))
    else:
        requested_ids = set(payload.work_item_ids)
        if not requested_ids:
            raise DomainError("Select at least one assignment to reassign")
        items = list(
            db.scalars(
                select(ScreeningWorkItem).where(
                    ScreeningWorkItem.project_id == project_id,
                    ScreeningWorkItem.stage == stage,
                    ScreeningWorkItem.id.in_(requested_ids),
                )
            )
        )
        if len(items) != len(requested_ids):
            raise NotFoundError("One or more screening assignments were not found")

    reassigned = bulk_reassign_work_items(db, items, payload.reviewer_id)
    reviewer = db.get(User, payload.reviewer_id)
    record_audit(
        db,
        action="screening_work_item.bulk_reassigned",
        entity_type="screening_work_item",
        entity_id=None,
        project_id=project_id,
        actor_id=admin.id,
        summary=(
            f"Reassigned {reassigned} screening assignments to "
            f"{reviewer.username if reviewer else payload.reviewer_id}"
        ),
        metadata={
            "stage": stage.value,
            "newReviewerId": payload.reviewer_id,
            "count": reassigned,
            "selectedAllFiltered": payload.select_all_filtered,
        },
    )
    db.commit()
    return {"reassigned": reassigned}


@router.patch(
    "/projects/{project_id}/screening/work-items/{item_id}/reassign",
    response_model=AssignmentItem,
)
def reassign_work_item_endpoint(
    project_id: str,
    item_id: str,
    payload: ReassignRequest,
    admin: User = Depends(require_project_manager_csrf),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    item = db.get(ScreeningWorkItem, item_id)
    if item is None or item.project_id != project_id:
        raise NotFoundError("Screening work item not found")
    previous_reviewer_id = item.assigned_reviewer_id
    reassign_work_item(db, item, payload.reviewer_id)
    publication = db.get(Publication, item.publication_id)
    reviewer = db.get(User, payload.reviewer_id)
    record_audit(
        db,
        action="screening_work_item.reassigned",
        entity_type="screening_work_item",
        entity_id=item.id,
        project_id=project_id,
        actor_id=admin.id,
        summary=f"Reassigned screening of "
        f"{publication.title if publication else item.publication_id}"
        f" to {reviewer.username if reviewer else payload.reviewer_id}",
        metadata={
            "stage": item.stage.value,
            "previousReviewerId": previous_reviewer_id,
            "newReviewerId": payload.reviewer_id,
        },
    )
    db.commit()
    return {
        "id": item.id,
        "publication_id": item.publication_id,
        "publication_title": publication.title if publication else "",
        "slot_number": item.slot_number,
        "status": item.status,
        "assigned_reviewer_id": item.assigned_reviewer_id,
        "assigned_reviewer_name": reviewer.display_name if reviewer else None,
    }
