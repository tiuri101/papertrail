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
from app.screening.models import (
    ScreeningDecision,
    ScreeningOutcome,
    ScreeningWorkItem,
    WorkItemStatus,
)
from app.screening.schemas import (
    AssignmentItem,
    AssignmentsPage,
    BulkReassignRequest,
    BulkReassignResponse,
    DecisionResponse,
    DecisionSubmit,
    DecisionSubmitResponse,
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


def _pending_workflow_steps(db: Session, item: ScreeningWorkItem) -> list[str]:
    """Describe work introduced by revising a completed screening stage."""
    from app.conflicts.service import valid_final_decision
    from app.extraction.models import ExtractionStatus, ExtractionWorkItem
    from app.fulltext.models import FullTextRetrieval, RetrievalStatus
    from app.projects.models import ProjectStage
    from app.quality.models import QualityConfig, QualityStatus, QualityWorkItem

    final = valid_final_decision(db, item.publication_id, item.stage)
    if final is None:
        stage_label = {
            ScreeningStage.TITLE_ABSTRACT: "title/abstract",
            ScreeningStage.FULL_TEXT: "full-text",
        }[item.stage]
        return [f"Resolve the revised {stage_label} screening decision"]
    if final.outcome != ScreeningOutcome.INCLUDE:
        return []

    steps: list[str] = []
    if item.stage == ScreeningStage.TITLE_ABSTRACT:
        retrieval = db.scalar(
            select(FullTextRetrieval).where(
                FullTextRetrieval.publication_id == item.publication_id
            )
        )
        if retrieval is None or retrieval.status in {
            RetrievalStatus.NOT_YET_SOUGHT,
            RetrievalStatus.REQUESTED,
        }:
            steps.extend(["Retrieve the full text", "Complete full-text screening"])
        elif retrieval.status == RetrievalStatus.AVAILABLE:
            full_text_final = valid_final_decision(
                db, item.publication_id, ScreeningStage.FULL_TEXT
            )
            if full_text_final is None:
                steps.append("Complete full-text screening")
                _append_automated_processing_step(db, item.publication_id, steps)
                return steps
            if full_text_final.outcome != ScreeningOutcome.INCLUDE:
                _append_automated_processing_step(db, item.publication_id, steps)
                return steps
        else:
            # A not-found or inaccessible report resolves retrieval without a
            # full-text screening decision.
            _append_automated_processing_step(db, item.publication_id, steps)
            return steps

    project = get_project(db, item.project_id)
    if project.stage in {ProjectStage.EXTRACTION, ProjectStage.COMPLETED}:
        extraction = db.scalar(
            select(ExtractionWorkItem).where(
                ExtractionWorkItem.publication_id == item.publication_id
            )
        )
        if extraction is None or extraction.status != ExtractionStatus.COMPLETED:
            steps.append("Complete data extraction")

        quality_config = db.scalar(
            select(QualityConfig).where(QualityConfig.project_id == item.project_id)
        )
        if quality_config is not None and quality_config.enabled:
            quality = db.scalar(
                select(QualityWorkItem).where(
                    QualityWorkItem.publication_id == item.publication_id
                )
            )
            if quality is None or quality.status != QualityStatus.COMPLETED:
                steps.append("Complete quality assessment")

    _append_automated_processing_step(db, item.publication_id, steps)
    return steps


def _append_automated_processing_step(
    db: Session, publication_id: str, steps: list[str]
) -> None:
    from app.fulltext.documents import active_document
    from app.llm.models import (
        DocumentTextExtraction,
        LlmExtractionRun,
        ProcessingStatus,
    )

    document = active_document(db, publication_id)
    if document is None:
        return
    extraction = db.scalar(
        select(DocumentTextExtraction).where(
            DocumentTextExtraction.document_id == document.id
        )
    )
    text_processing = extraction is not None and extraction.status in {
        ProcessingStatus.PENDING,
        ProcessingStatus.PROCESSING,
    }
    llm_processing = db.scalar(
        select(LlmExtractionRun.id).where(
            LlmExtractionRun.publication_id == publication_id,
            LlmExtractionRun.status.in_(
                [ProcessingStatus.PENDING, ProcessingStatus.PROCESSING]
            ),
        )
    )
    if text_processing or llm_processing is not None:
        steps.append("Wait for automated document and LLM processing")


def work_item_payload(db: Session, item: ScreeningWorkItem) -> dict[str, Any]:
    from app.llm.models import LlmTaskType
    from app.llm.task_service import feature_enabled

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
    task_type = {
        ScreeningStage.TITLE_ABSTRACT: LlmTaskType.TITLE_ABSTRACT_SCREENING,
        ScreeningStage.FULL_TEXT: LlmTaskType.FULL_TEXT_SCREENING,
    }[item.stage]
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
        "llm_assistance_enabled": feature_enabled(db, item.project_id, task_type),
    }


@router.post(
    "/projects/{project_id}/screening/{stage}/next",
    response_model=WorkItemResponse | None,
)
def next_item(
    project_id: str,
    stage: ScreeningStage,
    excluded_item_ids: list[str] = Query(default=[], alias="excludedItemId"),
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
    item = claim_next_work_item(
        db,
        project_id,
        stage,
        session.user.id,
        excluded_item_ids=set(excluded_item_ids),
    )
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
    response_model=DecisionSubmitResponse,
)
def decide(
    project_id: str,
    item_id: str,
    payload: DecisionSubmit,
    session: UserSession = Depends(require_csrf),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
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
    late_revision = was_stage_completed and decision.version > 1
    pending_steps = _pending_workflow_steps(db, item) if late_revision else []
    response = {
        "id": decision.id,
        "reviewer_id": decision.reviewer_id,
        "outcome": decision.outcome,
        "criteria_answers": decision.criteria_answers,
        "notes": decision.notes,
        "version": decision.version,
        "project_stage": project.stage,
        "stage_unchanged": late_revision,
        "pending_workflow_steps": pending_steps,
    }
    db.commit()
    return response


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
    payload_items: list[dict[str, Any]] = []
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
    if stage == ScreeningStage.FULL_TEXT:
        from app.fulltext.models import FullTextRetrieval, RetrievalStatus

        retrievals = list(
            db.scalars(
                select(FullTextRetrieval).where(
                    FullTextRetrieval.project_id == project_id,
                    FullTextRetrieval.updated_by_id == user.id,
                    FullTextRetrieval.status.in_(
                        [RetrievalStatus.NOT_FOUND, RetrievalStatus.INACCESSIBLE]
                    ),
                )
            )
        )
        for retrieval in retrievals:
            payload_items.append(
                {
                    "work_item_id": retrieval.id,
                    "submitted_at": retrieval.updated_at.isoformat(),
                    "publication": db.get(Publication, retrieval.publication_id),
                    "decision": None,
                    "retrieval_status": retrieval.status,
                    "retrieval_note": retrieval.note,
                }
            )
    payload_items.sort(key=lambda item: item["submitted_at"] or "", reverse=True)
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
