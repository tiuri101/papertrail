from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.accounts.dependencies import require_admin_csrf, require_csrf
from app.accounts.models import User, UserSession
from app.api.errors import NotFoundError
from app.audit.service import record_audit
from app.db.session import get_db
from app.projects.service import get_project, require_project_access
from app.quality.models import QualityConfig, QualityWorkItem
from app.quality.schemas import (
    QualityConfigUpdate,
    QualityItemResponse,
    QualityResponseModel,
    QualitySubmit,
)
from app.quality.service import claim_next_quality, submit_quality

router = APIRouter(tags=["quality assessment"])


@router.put("/projects/{project_id}/quality-config")
def configure_quality(
    project_id: str,
    payload: QualityConfigUpdate,
    admin: User = Depends(require_admin_csrf),
    db: Session = Depends(get_db),
):
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


@router.post("/projects/{project_id}/quality/next", response_model=QualityItemResponse | None)
def next_quality(
    project_id: str,
    session: UserSession = Depends(require_csrf),
    db: Session = Depends(get_db),
):
    require_project_access(db, project_id, session.user)
    item = claim_next_quality(db, project_id, session.user.id)
    db.commit()
    return item


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
):
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
    admin: User = Depends(require_admin_csrf),
    db: Session = Depends(get_db),
):
    item = db.get(QualityWorkItem, item_id)
    if item is None or item.project_id != project_id:
        raise NotFoundError("Quality work item not found")
    item.status = "available"
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
