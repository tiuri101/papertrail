from typing import Any

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.accounts.dependencies import get_current_user, require_csrf
from app.accounts.models import User, UserSession
from app.api.errors import ForbiddenError, NotFoundError
from app.audit.service import record_audit
from app.db.session import get_db
from app.extraction.final import get_current_final_extraction
from app.extraction.models import (
    ExtractionResponse,
    ExtractionStatus,
    ExtractionWorkItem,
)
from app.extraction.reconciliation import (
    reconciliation_detail,
    reconciliation_queue,
    submit_reconciliation,
)
from app.extraction.schemas import (
    CompletedExtractionSummary,
    ExtractionConfigResponse,
    ExtractionConfigUpdate,
    ExtractionDraftUpdate,
    ExtractionItemResponse,
    ExtractionOverride,
    ExtractionResponseModel,
    ExtractionSubmit,
    FinalExtractionModel,
    ReconciliationDetailResponse,
    ReconciliationQueueItem,
    ReconciliationSubmit,
)
from app.extraction.service import (
    active_fields,
    claim_next_extraction,
    extraction_required_reviewers,
    get_extraction_config,
    list_completed_for_reviewer,
    my_progress,
    override_extraction,
    project_form,
    reassign_work_items_from_ineligible_reviewers,
    save_draft,
    slot_responses_visible,
    submit_extraction,
    update_extraction_config,
)
from app.fulltext.documents import active_document
from app.projects.dependencies import (
    require_can_adjudicate,
    require_can_adjudicate_csrf,
    require_project_manager,
    require_project_manager_csrf,
)
from app.projects.models import ProjectMembership, TaskAllocationMode
from app.projects.service import (
    get_project,
    is_project_manager,
    require_project_access,
)
from app.publications.models import Publication
from app.screening.schemas import MyProgressResponse

router = APIRouter(tags=["extraction"])


@router.get(
    "/projects/{project_id}/extraction-config",
    response_model=ExtractionConfigResponse,
)
def get_extraction_config_endpoint(
    project_id: str,
    _: User = Depends(require_project_manager),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    get_project(db, project_id)
    config = get_extraction_config(db, project_id)
    return {
        "allocation_mode": (
            config.allocation_mode if config else TaskAllocationMode.CLAIM
        ),
        "required_reviewers": config.required_reviewers if config else 1,
    }


@router.put(
    "/projects/{project_id}/extraction-config",
    response_model=ExtractionConfigResponse,
)
def set_extraction_config(
    project_id: str,
    payload: ExtractionConfigUpdate,
    admin: User = Depends(require_project_manager_csrf),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    get_project(db, project_id)
    config = update_extraction_config(
        db,
        project_id,
        allocation_mode=payload.allocation_mode,
        required_reviewers=payload.required_reviewers,
    )
    record_audit(
        db,
        action="extraction.config_changed",
        entity_type="extraction_config",
        entity_id=config.id,
        project_id=project_id,
        actor_id=admin.id,
        summary="Updated data extraction allocation configuration",
        metadata={
            "allocationMode": config.allocation_mode.value,
            "requiredReviewers": config.required_reviewers,
        },
    )
    db.commit()
    return {
        "allocation_mode": config.allocation_mode,
        "required_reviewers": config.required_reviewers,
    }


def extraction_item_payload(
    db: Session,
    item: ExtractionWorkItem,
    *,
    viewer_id: str | None = None,
    include_response: bool = False,
) -> dict[str, Any]:
    form = project_form(db, item.project_id)
    required = extraction_required_reviewers(db, item.project_id)
    # Blinding: hide a sibling slot's answers/draft from a reviewer whose own
    # slot isn't complete yet. A manager/adjudicator (viewer_id=None, passed
    # by callers that already checked manager access) and the item's own
    # assignee always see it regardless of completion state.
    visible = (
        viewer_id is None
        or item.assigned_reviewer_id == viewer_id
        or slot_responses_visible(db, item, viewer_id)
    )
    response = None
    if include_response and visible:
        response = db.scalar(
            select(ExtractionResponse)
            .where(
                ExtractionResponse.work_item_id == item.id,
                ExtractionResponse.is_current.is_(True),
            )
            .order_by(ExtractionResponse.created_at.desc())
        )
    return {
        "id": item.id,
        "publication_id": item.publication_id,
        "slot_number": item.slot_number,
        "required_reviewers": required,
        "full_text_available": active_document(db, item.publication_id) is not None,
        "assigned_reviewer_id": item.assigned_reviewer_id,
        "status": item.status,
        "draft": (response.answers if response is not None else item.draft)
        if visible
        else {},
        "publication": db.get(Publication, item.publication_id),
        "fields": active_fields(db, form) if form else [],
        "current_response": response,
    }


@router.get(
    "/projects/{project_id}/extraction/progress",
    response_model=MyProgressResponse,
)
def my_extraction_progress(
    project_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, int]:
    require_project_access(db, project_id, user)
    return my_progress(db, project_id, user.id)


@router.get(
    "/projects/{project_id}/extraction/mine",
    response_model=list[CompletedExtractionSummary],
)
def my_completed_extractions(
    project_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[dict[str, Any]]:
    require_project_access(db, project_id, user)
    return [
        {
            "id": item.id,
            "publication_id": item.publication_id,
            "slot_number": item.slot_number,
            "publication": db.get(Publication, item.publication_id),
            "completed_at": item.completed_at,
            "version": response.version,
        }
        for item, response in list_completed_for_reviewer(db, project_id, user.id)
    ]


@router.get(
    "/projects/{project_id}/extraction/{item_id}",
    response_model=ExtractionItemResponse,
)
def get_extraction_for_review(
    project_id: str,
    item_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    require_project_access(db, project_id, user)
    item = db.get(ExtractionWorkItem, item_id)
    if item is None or item.project_id != project_id:
        raise NotFoundError("Extraction work item not found")
    is_manager = is_project_manager(db, project_id, user)
    if not is_manager:
        membership = db.scalar(
            select(ProjectMembership).where(
                ProjectMembership.project_id == project_id,
                ProjectMembership.user_id == user.id,
                ProjectMembership.can_extract.is_(True),
            )
        )
        if membership is None or item.assigned_reviewer_id != user.id:
            raise ForbiddenError("Extraction is assigned to another reviewer")
    return extraction_item_payload(
        db,
        item,
        viewer_id=None if is_manager else user.id,
        include_response=True,
    )


@router.post(
    "/projects/{project_id}/extraction/next",
    response_model=ExtractionItemResponse | None,
)
def next_extraction(
    project_id: str,
    excluded_item_ids: list[str] = Query(default=[], alias="excludedItemId"),
    session: UserSession = Depends(require_csrf),
    db: Session = Depends(get_db),
) -> dict[str, Any] | None:
    require_project_access(db, project_id, session.user)
    reassign_work_items_from_ineligible_reviewers(db, project_id)
    item = claim_next_extraction(
        db, project_id, session.user.id, set(excluded_item_ids)
    )
    db.commit()
    return (
        extraction_item_payload(db, item, viewer_id=session.user.id)
        if item
        else None
    )


@router.post("/projects/{project_id}/extraction/{item_id}/release")
def release_extraction(
    project_id: str,
    item_id: str,
    session: UserSession = Depends(require_csrf),
    db: Session = Depends(get_db),
) -> dict[str, str]:
    item = db.get(ExtractionWorkItem, item_id)
    if item is None or item.project_id != project_id:
        raise NotFoundError("Extraction work item not found")
    if item.assigned_reviewer_id != session.user.id:
        raise ForbiddenError("Extraction is assigned to another reviewer")
    if item.status != ExtractionStatus.COMPLETED:
        item.status = ExtractionStatus.AVAILABLE
        item.reserved_until = None
    db.commit()
    return {"status": "released"}


@router.put("/projects/{project_id}/extraction/{item_id}/draft")
def update_extraction_draft(
    project_id: str,
    item_id: str,
    payload: ExtractionDraftUpdate,
    session: UserSession = Depends(require_csrf),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    item = db.get(ExtractionWorkItem, item_id)
    if item is None or item.project_id != project_id:
        raise NotFoundError("Extraction work item not found")
    save_draft(item, session.user.id, payload.draft)
    db.commit()
    return {"status": "saved"}


@router.post(
    "/projects/{project_id}/extraction/{item_id}",
    response_model=ExtractionResponseModel,
)
def complete_extraction(
    project_id: str,
    item_id: str,
    payload: ExtractionSubmit,
    session: UserSession = Depends(require_csrf),
    db: Session = Depends(get_db),
) -> ExtractionResponse:
    item = db.get(ExtractionWorkItem, item_id)
    if item is None or item.project_id != project_id:
        raise NotFoundError("Extraction work item not found")
    response = submit_extraction(
        db,
        item,
        session.user.id,
        payload.answers,
        suggestion_actions=payload.suggestion_actions,
    )
    record_audit(
        db,
        action="extraction.submitted",
        entity_type="extraction_response",
        entity_id=response.id,
        project_id=project_id,
        actor_id=session.user.id,
        summary="Submitted data extraction",
        metadata={"version": response.version},
    )
    from app.projects.lifecycle import evaluate_project_completion
    from app.projects.service import get_project

    evaluate_project_completion(db, get_project(db, project_id))
    db.commit()
    return response


@router.post("/projects/{project_id}/extraction/{item_id}/reopen")
def reopen_extraction(
    project_id: str,
    item_id: str,
    admin: User = Depends(require_project_manager_csrf),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    item = db.get(ExtractionWorkItem, item_id)
    if item is None or item.project_id != project_id:
        raise NotFoundError("Extraction work item not found")
    item.status = ExtractionStatus.AVAILABLE
    item.completed_at = None
    item.reserved_until = None
    record_audit(
        db,
        action="extraction.reopened",
        entity_type="extraction_work_item",
        entity_id=item.id,
        project_id=project_id,
        actor_id=admin.id,
        summary="Reopened data extraction",
    )
    db.commit()
    return {"status": "reopened"}


@router.post(
    "/projects/{project_id}/extraction/{item_id}/override",
    response_model=ExtractionResponseModel,
)
def override_completed_extraction(
    project_id: str,
    item_id: str,
    payload: ExtractionOverride,
    manager: User = Depends(require_project_manager_csrf),
    db: Session = Depends(get_db),
) -> ExtractionResponse:
    item = db.get(ExtractionWorkItem, item_id)
    if item is None or item.project_id != project_id:
        raise NotFoundError("Extraction work item not found")
    response, previous = override_extraction(
        db, item, manager.id, payload.answers, payload.reason
    )
    changed_fields = sorted(
        key
        for key in set(previous.answers) | set(response.answers)
        if previous.answers.get(key) != response.answers.get(key)
    )
    publication = db.get(Publication, item.publication_id)
    publication_label = publication.title if publication else item.publication_id
    record_audit(
        db,
        action="extraction.overridden",
        entity_type="extraction_response",
        entity_id=response.id,
        project_id=project_id,
        actor_id=manager.id,
        summary=f'Overrode data extraction for "{publication_label}"',
        metadata={
            "reason": payload.reason,
            "previousVersion": previous.version,
            "newVersion": response.version,
            "changedFields": changed_fields,
        },
    )
    record_audit(
        db,
        action="extraction.final_overridden",
        entity_type="publication",
        entity_id=item.publication_id,
        project_id=project_id,
        actor_id=manager.id,
        summary=f'Authoritative extraction manually overridden for "{publication_label}"',
        metadata={"changedFields": changed_fields},
    )
    from app.projects.lifecycle import evaluate_project_completion
    from app.projects.service import get_project as _get_project

    evaluate_project_completion(db, _get_project(db, project_id))
    db.commit()
    return response


@router.get(
    "/projects/{project_id}/extraction/publications/{publication_id}/final",
    response_model=FinalExtractionModel | None,
)
def get_final_extraction(
    project_id: str,
    publication_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any] | None:
    require_project_access(db, project_id, user)
    publication = db.get(Publication, publication_id)
    if publication is None or publication.project_id != project_id:
        raise NotFoundError("Publication not found")
    final = get_current_final_extraction(db, publication_id)
    if final is None:
        return None
    return {
        "id": final.id,
        "publication_id": final.publication_id,
        "answers": final.answers,
        "form_version_id": final.form_version_id,
        "resolution_method": final.resolution_method,
        "resolved_by_id": final.resolved_by_id,
        "note": final.note,
        "field_provenance": final.field_provenance,
        "contributing_response_ids": final.contributing_response_ids,
        "created_at": final.created_at,
    }


@router.get(
    "/projects/{project_id}/extraction/reconciliation",
    response_model=list[ReconciliationQueueItem],
)
def list_reconciliation_queue(
    project_id: str,
    _: User = Depends(require_can_adjudicate),
    db: Session = Depends(get_db),
) -> list[dict[str, Any]]:
    get_project(db, project_id)
    return [
        {"publication": publication}
        for publication in reconciliation_queue(db, project_id)
    ]


@router.get(
    "/projects/{project_id}/extraction/reconciliation/{publication_id}",
    response_model=ReconciliationDetailResponse,
)
def get_reconciliation_detail(
    project_id: str,
    publication_id: str,
    _: User = Depends(require_can_adjudicate),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    get_project(db, project_id)
    publication, fields, comparison = reconciliation_detail(db, publication_id)
    if publication.project_id != project_id:
        raise NotFoundError("Publication not found")
    return {
        "publication": publication,
        "full_text_available": active_document(db, publication_id) is not None,
        "fields": fields,
        "comparisons": [
            {
                "stable_key": item.stable_key,
                "field_type": item.field_type.value,
                "value_a": item.value_a,
                "value_b": item.value_b,
                "agree": item.agree,
            }
            for item in comparison.fields
        ],
    }


@router.post(
    "/projects/{project_id}/extraction/reconciliation/{publication_id}",
    response_model=FinalExtractionModel,
)
def resolve_reconciliation(
    project_id: str,
    publication_id: str,
    payload: ReconciliationSubmit,
    adjudicator: User = Depends(require_can_adjudicate_csrf),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    get_project(db, project_id)
    publication = db.get(Publication, publication_id)
    if publication is None or publication.project_id != project_id:
        raise NotFoundError("Publication not found")
    final = submit_reconciliation(
        db,
        publication_id,
        adjudicator.id,
        {key: choice.model_dump() for key, choice in payload.field_choices.items()},
        payload.note,
    )
    from app.projects.lifecycle import evaluate_project_completion
    from app.projects.service import get_project as _get_project

    evaluate_project_completion(db, _get_project(db, project_id))
    db.commit()
    return {
        "id": final.id,
        "publication_id": final.publication_id,
        "answers": final.answers,
        "form_version_id": final.form_version_id,
        "resolution_method": final.resolution_method,
        "resolved_by_id": final.resolved_by_id,
        "note": final.note,
        "field_provenance": final.field_provenance,
        "contributing_response_ids": final.contributing_response_ids,
        "created_at": final.created_at,
    }
