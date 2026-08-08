from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.accounts.dependencies import require_csrf
from app.accounts.models import User, UserSession
from app.api.errors import NotFoundError
from app.audit.service import record_audit
from app.db.session import get_db
from app.extraction.models import ExtractionWorkItem
from app.extraction.schemas import (
    ExtractionDraftUpdate,
    ExtractionItemResponse,
    ExtractionResponseModel,
    ExtractionSubmit,
)
from app.extraction.service import (
    active_fields,
    claim_next_extraction,
    project_form,
    reassign_work_items_from_ineligible_reviewers,
    save_draft,
    submit_extraction,
)
from app.fulltext.documents import active_document
from app.projects.dependencies import require_project_manager_csrf
from app.projects.service import require_project_access
from app.publications.models import Publication

router = APIRouter(tags=["extraction"])


def extraction_item_payload(db: Session, item: ExtractionWorkItem) -> dict:
    form = project_form(db, item.project_id)
    return {
        "id": item.id,
        "publication_id": item.publication_id,
        "full_text_available": active_document(db, item.publication_id) is not None,
        "assigned_reviewer_id": item.assigned_reviewer_id,
        "status": item.status,
        "draft": item.draft,
        "publication": db.get(Publication, item.publication_id),
        "fields": active_fields(db, form) if form else [],
    }


@router.post(
    "/projects/{project_id}/extraction/next",
    response_model=ExtractionItemResponse | None,
)
def next_extraction(
    project_id: str,
    session: UserSession = Depends(require_csrf),
    db: Session = Depends(get_db),
):
    require_project_access(db, project_id, session.user)
    reassign_work_items_from_ineligible_reviewers(db, project_id)
    item = claim_next_extraction(db, project_id, session.user.id)
    db.commit()
    return extraction_item_payload(db, item) if item else None


@router.put("/projects/{project_id}/extraction/{item_id}/draft")
def update_extraction_draft(
    project_id: str,
    item_id: str,
    payload: ExtractionDraftUpdate,
    session: UserSession = Depends(require_csrf),
    db: Session = Depends(get_db),
):
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
):
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
):
    item = db.get(ExtractionWorkItem, item_id)
    if item is None or item.project_id != project_id:
        raise NotFoundError("Extraction work item not found")
    item.status = "available"
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
