from __future__ import annotations

from fastapi import APIRouter, Depends, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.accounts.dependencies import get_current_user, require_admin_csrf
from app.accounts.models import User
from app.accounts.service import get_user_or_raise
from app.audit.service import record_audit
from app.db.session import get_db
from app.projects.models import Criterion, ExclusionReason, Project, ResearchQuestion, ScreeningConfig, ScreeningStage
from app.projects.schemas import (
    CriterionCreate,
    CriterionResponse,
    ExclusionReasonCreate,
    ExclusionReasonResponse,
    MembershipCreate,
    MembershipResponse,
    OrderedTextCreate,
    ProjectCreate,
    ProjectDetail,
    ProjectReopen,
    ProjectSummary,
    ResearchQuestionResponse,
    ScreeningConfigResponse,
    ScreeningConfigUpdate,
)
from app.projects.service import (
    add_membership,
    create_project,
    get_project,
    list_projects_for_user,
    next_position,
    require_project_access,
)

router = APIRouter(prefix="/projects", tags=["projects"])


@router.get("", response_model=list[ProjectSummary])
def list_projects(user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> list[Project]:
    return list_projects_for_user(db, user)


@router.post("", response_model=ProjectSummary, status_code=status.HTTP_201_CREATED)
def add_project(payload: ProjectCreate, admin: User = Depends(require_admin_csrf), db: Session = Depends(get_db)) -> Project:
    project = create_project(db, payload.name, payload.description, payload.review_type)
    record_audit(db, action="project.created", entity_type="project", entity_id=project.id, project_id=project.id, actor_id=admin.id, summary=f"Created project {project.name}")
    db.commit()
    return project


@router.get("/{project_id}", response_model=ProjectDetail)
def project_detail(project_id: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> Project:
    return require_project_access(db, project_id, user)


@router.post("/{project_id}/members", response_model=MembershipResponse, status_code=status.HTTP_201_CREATED)
def add_project_member(project_id: str, payload: MembershipCreate, _: User = Depends(require_admin_csrf), db: Session = Depends(get_db)):
    project = get_project(db, project_id)
    user = get_user_or_raise(db, payload.user_id)
    membership = add_membership(
        db,
        project,
        user,
        can_title_abstract_screen=payload.can_title_abstract_screen,
        can_full_text_screen=payload.can_full_text_screen,
        can_extract=payload.can_extract,
        can_assess_quality=payload.can_assess_quality,
        can_adjudicate=payload.can_adjudicate,
    )
    record_audit(db, action="membership.created", entity_type="project_membership", entity_id=membership.id, project_id=project.id, actor_id=_.id, summary=f"Added reviewer {user.username} to project")
    db.commit()
    return membership


@router.post("/{project_id}/research-questions", response_model=ResearchQuestionResponse, status_code=status.HTTP_201_CREATED)
def add_research_question(project_id: str, payload: OrderedTextCreate, admin: User = Depends(require_admin_csrf), db: Session = Depends(get_db)):
    get_project(db, project_id)
    item = ResearchQuestion(project_id=project_id, text=payload.text.strip(), position=payload.position if payload.position is not None else next_position(db, ResearchQuestion, project_id))
    db.add(item)
    db.flush()
    record_audit(db, action="research_question.created", entity_type="research_question", entity_id=item.id, project_id=project_id, actor_id=admin.id, summary="Added research question")
    db.commit()
    return item


@router.post("/{project_id}/criteria", response_model=CriterionResponse, status_code=status.HTTP_201_CREATED)
def add_criterion(project_id: str, payload: CriterionCreate, admin: User = Depends(require_admin_csrf), db: Session = Depends(get_db)):
    get_project(db, project_id)
    item = Criterion(project_id=project_id, kind=payload.kind, text=payload.text.strip(), position=payload.position if payload.position is not None else next_position(db, Criterion, project_id))
    db.add(item)
    db.flush()
    record_audit(db, action="criterion.created", entity_type="criterion", entity_id=item.id, project_id=project_id, actor_id=admin.id, summary=f"Added {payload.kind} criterion")
    db.commit()
    return item


@router.put("/{project_id}/screening-config/{stage}", response_model=ScreeningConfigResponse)
def set_screening_config(project_id: str, stage: ScreeningStage, payload: ScreeningConfigUpdate, admin: User = Depends(require_admin_csrf), db: Session = Depends(get_db)):
    get_project(db, project_id)
    config = db.scalar(select(ScreeningConfig).where(ScreeningConfig.project_id == project_id, ScreeningConfig.stage == stage))
    assert config is not None
    config.required_reviewers = payload.required_reviewers
    config.allocation_mode = payload.allocation_mode
    config.conflict_resolution = payload.conflict_resolution
    config.uncertain_resolution = payload.uncertain_resolution
    record_audit(db, action="screening_config.updated", entity_type="screening_config", entity_id=config.id, project_id=project_id, actor_id=admin.id, summary=f"Updated {stage.value} screening configuration")
    db.commit()
    return config


@router.post("/{project_id}/exclusion-reasons/{stage}", response_model=ExclusionReasonResponse, status_code=status.HTTP_201_CREATED)
def add_exclusion_reason(project_id: str, stage: ScreeningStage, payload: ExclusionReasonCreate, admin: User = Depends(require_admin_csrf), db: Session = Depends(get_db)):
    get_project(db, project_id)
    item = ExclusionReason(project_id=project_id, stage=stage, label=payload.label.strip(), position=payload.position if payload.position is not None else next_position(db, ExclusionReason, project_id, stage=stage))
    db.add(item)
    db.flush()
    record_audit(db, action="exclusion_reason.created", entity_type="exclusion_reason", entity_id=item.id, project_id=project_id, actor_id=admin.id, summary=f"Added {stage.value} exclusion reason")
    db.commit()
    return item

@router.get("/{project_id}/integrity")
def project_integrity(
    project_id: str,
    admin: User = Depends(require_admin_csrf),
    db: Session = Depends(get_db),
):
    from app.projects.lifecycle import project_integrity_issues

    project = require_project_access(db, project_id, admin)
    return {"issues": project_integrity_issues(db, project)}


@router.post("/{project_id}/reopen", response_model=ProjectSummary)
def reopen_completed_project(
    project_id: str,
    payload: ProjectReopen,
    admin: User = Depends(require_admin_csrf),
    db: Session = Depends(get_db),
):
    from app.api.errors import DomainError
    from app.projects.lifecycle import reopen_project

    project = get_project(db, project_id)
    try:
        reopen_project(db, project, payload.target_stage, admin.id)
    except ValueError as exc:
        raise DomainError(str(exc)) from exc
    db.commit()
    return project
