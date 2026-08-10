from typing import Any

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.accounts.dependencies import get_current_user, require_csrf
from app.accounts.models import User, UserSession
from app.api.errors import ForbiddenError, NotFoundError
from app.audit.service import record_audit
from app.db.session import get_db
from app.extraction.models import (
    ExtractionConfig,
    ExtractionResponse,
    ExtractionStatus,
    ExtractionWorkItem,
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
)
from app.extraction.service import (
    active_fields,
    claim_next_extraction,
    get_extraction_config,
    list_completed_for_reviewer,
    my_progress,
    override_extraction,
    project_form,
    reassign_work_items_from_ineligible_reviewers,
    save_draft,
    submit_extraction,
)
from app.fulltext.documents import active_document
from app.projects.dependencies import (
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
        )
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
    config = get_extraction_config(db, project_id)
    if config is None:
        config = ExtractionConfig(project_id=project_id)
        db.add(config)
    config.allocation_mode = payload.allocation_mode
    db.flush()
    record_audit(
        db,
        action="extraction.config_updated",
        entity_type="extraction_config",
        entity_id=config.id,
        project_id=project_id,
        actor_id=admin.id,
        summary="Updated data extraction allocation configuration",
    )
    db.commit()
    return {"allocation_mode": config.allocation_mode}


def extraction_item_payload(
    db: Session, item: ExtractionWorkItem, *, include_response: bool = False
) -> dict[str, Any]:
    form = project_form(db, item.project_id)
    response = None
    if include_response:
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
        "full_text_available": active_document(db, item.publication_id) is not None,
        "assigned_reviewer_id": item.assigned_reviewer_id,
        "status": item.status,
        "draft": response.answers if response is not None else item.draft,
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
    if not is_project_manager(db, project_id, user):
        membership = db.scalar(
            select(ProjectMembership).where(
                ProjectMembership.project_id == project_id,
                ProjectMembership.user_id == user.id,
                ProjectMembership.can_extract.is_(True),
            )
        )
        if membership is None or item.assigned_reviewer_id != user.id:
            raise ForbiddenError("Extraction is assigned to another reviewer")
    return extraction_item_payload(db, item, include_response=True)


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
    return extraction_item_payload(db, item) if item else None


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
    response, previous = override_extraction(db, item, manager.id, payload.answers)
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
    db.commit()
    return response
