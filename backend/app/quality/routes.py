from typing import Any

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.accounts.dependencies import get_current_user, require_csrf
from app.accounts.models import User, UserSession
from app.api.errors import ForbiddenError, NotFoundError
from app.audit.service import record_audit
from app.db.session import get_db
from app.projects.dependencies import (
    require_project_manager,
    require_project_manager_csrf,
)
from app.projects.models import ProjectMembership
from app.projects.service import get_project, is_project_manager, require_project_access
from app.publications.models import Publication
from app.quality.models import (
    QualityConfig,
    QualityResponse,
    QualityStatus,
    QualityWorkItem,
)
from app.quality.schemas import (
    CompletedQualitySummary,
    QualityConfigResponse,
    QualityConfigUpdate,
    QualityDraftUpdate,
    QualityItemResponse,
    QualityResponseModel,
    QualitySubmit,
)
from app.quality.service import (
    active_fields,
    claim_next_quality,
    list_completed_for_reviewer,
    my_progress,
    quality_form,
    reassign_work_items_from_ineligible_reviewers,
    save_draft,
    submit_quality,
)
from app.screening.schemas import MyProgressResponse

router = APIRouter(tags=["quality assessment"])


def quality_item_payload(
    db: Session, item: QualityWorkItem, *, include_response: bool = False
) -> dict[str, Any]:
    form = quality_form(db, item.project_id)
    response = None
    if include_response:
        response = db.scalar(
            select(QualityResponse).where(
                QualityResponse.work_item_id == item.id,
                QualityResponse.is_current.is_(True),
            )
        )
    return {
        "id": item.id,
        "publication_id": item.publication_id,
        "status": item.status,
        "draft": item.draft,
        "publication": db.get(Publication, item.publication_id),
        "fields": active_fields(db, form) if form else [],
        "current_response": response,
    }


@router.get(
    "/projects/{project_id}/quality-config", response_model=QualityConfigResponse
)
def get_quality_config(
    project_id: str,
    _: User = Depends(require_project_manager),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    get_project(db, project_id)
    config = db.scalar(
        select(QualityConfig).where(QualityConfig.project_id == project_id)
    )
    if config is None:
        return {"enabled": False, "mode": "both", "aggregation": "sum"}
    return {
        "enabled": config.enabled,
        "mode": config.mode,
        "aggregation": config.aggregation,
    }


@router.put("/projects/{project_id}/quality-config")
def configure_quality(
    project_id: str,
    payload: QualityConfigUpdate,
    admin: User = Depends(require_project_manager_csrf),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    get_project(db, project_id)
    config = db.query(QualityConfig).filter_by(project_id=project_id).one_or_none()
    if config is None:
        config = QualityConfig(project_id=project_id)
        db.add(config)
    config.enabled = payload.enabled
    config.mode = payload.mode
    config.aggregation = payload.aggregation
    db.flush()
    record_audit(
        db,
        action="quality.config_updated",
        entity_type="quality_config",
        entity_id=config.id,
        project_id=project_id,
        actor_id=admin.id,
        summary="Updated quality-assessment configuration",
    )
    db.commit()
    return {
        "enabled": config.enabled,
        "mode": config.mode,
        "aggregation": config.aggregation,
    }


@router.get(
    "/projects/{project_id}/quality/progress",
    response_model=MyProgressResponse,
)
def my_quality_progress(
    project_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, int]:
    require_project_access(db, project_id, user)
    return my_progress(db, project_id, user.id)


@router.get(
    "/projects/{project_id}/quality/mine",
    response_model=list[CompletedQualitySummary],
)
def my_completed_quality_assessments(
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
            "total_score": response.total_score,
        }
        for item, response in list_completed_for_reviewer(db, project_id, user.id)
    ]


@router.get(
    "/projects/{project_id}/quality/{item_id}",
    response_model=QualityItemResponse,
)
def get_quality_for_review(
    project_id: str,
    item_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    require_project_access(db, project_id, user)
    item = db.get(QualityWorkItem, item_id)
    if item is None or item.project_id != project_id:
        raise NotFoundError("Quality work item not found")
    if not is_project_manager(db, project_id, user):
        membership = db.scalar(
            select(ProjectMembership).where(
                ProjectMembership.project_id == project_id,
                ProjectMembership.user_id == user.id,
                ProjectMembership.can_assess_quality.is_(True),
            )
        )
        if membership is None or item.assigned_reviewer_id != user.id:
            raise ForbiddenError("Quality assessment is assigned to another reviewer")
    return quality_item_payload(db, item, include_response=True)


@router.post(
    "/projects/{project_id}/quality/next", response_model=QualityItemResponse | None
)
def next_quality(
    project_id: str,
    session: UserSession = Depends(require_csrf),
    db: Session = Depends(get_db),
) -> dict[str, Any] | None:
    require_project_access(db, project_id, session.user)
    reassign_work_items_from_ineligible_reviewers(db, project_id)
    item = claim_next_quality(db, project_id, session.user.id)
    db.commit()
    return quality_item_payload(db, item) if item else None


@router.put("/projects/{project_id}/quality/{item_id}/draft")
def update_quality_draft(
    project_id: str,
    item_id: str,
    payload: QualityDraftUpdate,
    session: UserSession = Depends(require_csrf),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    item = db.get(QualityWorkItem, item_id)
    if item is None or item.project_id != project_id:
        raise NotFoundError("Quality work item not found")
    save_draft(item, session.user.id, payload.draft)
    db.commit()
    return {"status": "saved"}


@router.post(
    "/projects/{project_id}/quality/{item_id}",
    response_model=QualityResponseModel,
)
def complete_quality(
    project_id: str,
    item_id: str,
    payload: QualitySubmit,
    session: UserSession = Depends(require_csrf),
    db: Session = Depends(get_db),
) -> QualityResponse:
    item = db.get(QualityWorkItem, item_id)
    if item is None or item.project_id != project_id:
        raise NotFoundError("Quality work item not found")
    response = submit_quality(db, item, session.user.id, payload.answers)
    record_audit(
        db,
        action="quality.submitted",
        entity_type="quality_response",
        entity_id=response.id,
        project_id=project_id,
        actor_id=session.user.id,
        summary="Submitted quality assessment",
        metadata={"version": response.version, "totalScore": response.total_score},
    )
    from app.projects.lifecycle import evaluate_project_completion
    from app.projects.service import get_project

    evaluate_project_completion(db, get_project(db, project_id))
    db.commit()
    return response


@router.post("/projects/{project_id}/quality/{item_id}/reopen")
def reopen_quality(
    project_id: str,
    item_id: str,
    admin: User = Depends(require_project_manager_csrf),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    item = db.get(QualityWorkItem, item_id)
    if item is None or item.project_id != project_id:
        raise NotFoundError("Quality work item not found")
    item.status = QualityStatus.AVAILABLE
    item.completed_at = None
    item.reserved_until = None
    record_audit(
        db,
        action="quality.reopened",
        entity_type="quality_work_item",
        entity_id=item.id,
        project_id=project_id,
        actor_id=admin.id,
        summary="Reopened quality assessment",
    )
    db.commit()
    return {"status": "reopened"}
