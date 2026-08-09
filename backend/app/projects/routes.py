from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.accounts.dependencies import get_current_user, require_csrf
from app.accounts.models import User, UserSession
from app.accounts.service import get_user_or_raise
from app.api.errors import ConflictError, NotFoundError
from app.audit.service import record_audit
from app.db.session import get_db
from app.imports.schemas import JobResponse
from app.jobs.models import BackgroundJob, JobStatus
from app.notifications.service import queue_membership_email
from app.projects.dependencies import (
    require_project_manager_csrf,
    require_project_member_csrf,
)
from app.projects.models import (
    Criterion,
    Project,
    ProjectMembership,
    ResearchQuestion,
    ScreeningConfig,
    ScreeningStage,
)
from app.projects.schemas import (
    CriterionCreate,
    CriterionResponse,
    CriterionUpdate,
    HighlightKeywordsResponse,
    HighlightKeywordsUpdate,
    MembershipCreate,
    MembershipResponse,
    MembershipUpdate,
    OrderedTextCreate,
    ProjectChecklist,
    ProjectCreate,
    ProjectDetail,
    ProjectDetailsUpdate,
    ProjectReopen,
    ProjectSummary,
    ResearchQuestionResponse,
    ResearchQuestionUpdate,
    ScreeningConfigResponse,
    ScreeningConfigUpdate,
)
from app.projects.service import (
    add_membership,
    create_project,
    get_membership,
    get_project,
    is_project_manager,
    list_projects_for_user,
    next_position,
    parse_highlight_keywords,
    remove_membership,
    require_project_access,
    serialize_highlight_keywords,
    update_membership,
)

router = APIRouter(prefix="/projects", tags=["projects"])


@router.get("", response_model=list[ProjectSummary])
def list_projects(
    user: User = Depends(get_current_user), db: Session = Depends(get_db)
) -> list[Project]:
    return list_projects_for_user(db, user)


@router.post("", response_model=ProjectSummary, status_code=status.HTTP_201_CREATED)
def add_project(
    payload: ProjectCreate,
    session: UserSession = Depends(require_csrf),
    db: Session = Depends(get_db),
) -> Project:
    user = session.user
    project = create_project(
        db, payload.name, payload.description, payload.review_type, user
    )
    record_audit(
        db,
        action="project.created",
        entity_type="project",
        entity_id=project.id,
        project_id=project.id,
        actor_id=user.id,
        summary=f"Created project {project.name}",
    )
    db.commit()
    return project


def _serialize_project_detail(
    db: Session, project: Project, user: User
) -> ProjectDetail:
    from app.llm.schema_service import project_settings

    llm_settings = project_settings(db, project.id)
    return ProjectDetail(
        id=project.id,
        name=project.name,
        description=project.description,
        review_type=project.review_type,
        stage=project.stage,
        memberships=[MembershipResponse.model_validate(m) for m in project.memberships],
        research_questions=[
            ResearchQuestionResponse.model_validate(item)
            for item in project.research_questions
            if item.is_active
        ],
        criteria=[
            CriterionResponse.model_validate(item)
            for item in project.criteria
            if item.is_active
        ],
        screening_configs=[
            ScreeningConfigResponse.model_validate(c) for c in project.screening_configs
        ],
        can_manage=is_project_manager(db, project.id, user),
        extraction_validation_enabled=bool(
            llm_settings and llm_settings.extraction_validation_enabled
        ),
    )


@router.get("/{project_id}", response_model=ProjectDetail)
def project_detail(
    project_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> ProjectDetail:
    project = require_project_access(db, project_id, user)
    return _serialize_project_detail(db, project, user)


@router.patch("/{project_id}", response_model=ProjectDetail)
def update_project_details(
    project_id: str,
    payload: ProjectDetailsUpdate,
    admin: User = Depends(require_project_manager_csrf),
    db: Session = Depends(get_db),
) -> ProjectDetail:
    project = get_project(db, project_id)
    project.name = payload.name.strip()
    project.description = payload.description.strip() if payload.description else None
    record_audit(
        db,
        action="project.updated",
        entity_type="project",
        entity_id=project.id,
        project_id=project.id,
        actor_id=admin.id,
        summary=f"Renamed project to {project.name}",
    )
    db.commit()
    return _serialize_project_detail(db, project, admin)


@router.get("/{project_id}/checklist", response_model=ProjectChecklist)
def project_checklist_endpoint(
    project_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    from app.projects.checklist import project_checklist

    project = require_project_access(db, project_id, user)
    return project_checklist(db, project)


@router.post(
    "/{project_id}/members",
    response_model=MembershipResponse,
    status_code=status.HTTP_201_CREATED,
)
def add_project_member(
    project_id: str,
    payload: MembershipCreate,
    _: User = Depends(require_project_manager_csrf),
    db: Session = Depends(get_db),
) -> ProjectMembership:
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
    record_audit(
        db,
        action="membership.created",
        entity_type="project_membership",
        entity_id=membership.id,
        project_id=project.id,
        actor_id=_.id,
        summary=f"Added reviewer {user.username} to project",
    )
    queue_membership_email(
        db, membership=membership, project=project, user=user, added=True
    )
    db.commit()
    return membership


@router.patch(
    "/{project_id}/members/{member_id}",
    response_model=MembershipResponse,
)
def update_project_member(
    project_id: str,
    member_id: str,
    payload: MembershipUpdate,
    admin: User = Depends(require_project_manager_csrf),
    db: Session = Depends(get_db),
) -> ProjectMembership:
    get_project(db, project_id)
    membership = get_membership(db, project_id, member_id)
    membership = update_membership(
        db,
        membership,
        can_title_abstract_screen=payload.can_title_abstract_screen,
        can_full_text_screen=payload.can_full_text_screen,
        can_extract=payload.can_extract,
        can_assess_quality=payload.can_assess_quality,
        can_adjudicate=payload.can_adjudicate,
    )
    from app.extraction.service import (
        reassign_work_items_from_ineligible_reviewers as reassign_extraction,
    )
    from app.quality.service import (
        reassign_work_items_from_ineligible_reviewers as reassign_quality,
    )
    from app.screening.service import reassign_work_items_from_ineligible_reviewers

    for stage in (ScreeningStage.TITLE_ABSTRACT, ScreeningStage.FULL_TEXT):
        reassign_work_items_from_ineligible_reviewers(db, project_id, stage)
    reassign_extraction(db, project_id)
    reassign_quality(db, project_id)
    record_audit(
        db,
        action="membership.updated",
        entity_type="project_membership",
        entity_id=membership.id,
        project_id=project_id,
        actor_id=admin.id,
        summary="Updated reviewer stage assignments",
    )
    db.commit()
    return membership


@router.delete(
    "/{project_id}/members/{member_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def delete_project_member(
    project_id: str,
    member_id: str,
    admin: User = Depends(require_project_manager_csrf),
    db: Session = Depends(get_db),
) -> None:
    project = get_project(db, project_id)
    membership = get_membership(db, project_id, member_id)
    user = get_user_or_raise(db, membership.user_id)
    record_audit(
        db,
        action="membership.removed",
        entity_type="project_membership",
        entity_id=membership.id,
        project_id=project_id,
        actor_id=admin.id,
        summary="Removed reviewer from project",
    )
    queue_membership_email(
        db, membership=membership, project=project, user=user, added=False
    )
    remove_membership(db, membership)
    from app.extraction.service import (
        reassign_work_items_from_ineligible_reviewers as reassign_extraction,
    )
    from app.quality.service import (
        reassign_work_items_from_ineligible_reviewers as reassign_quality,
    )
    from app.screening.service import reassign_work_items_from_ineligible_reviewers

    for stage in (ScreeningStage.TITLE_ABSTRACT, ScreeningStage.FULL_TEXT):
        reassign_work_items_from_ineligible_reviewers(db, project_id, stage)
    reassign_extraction(db, project_id)
    reassign_quality(db, project_id)
    db.commit()


@router.post(
    "/{project_id}/research-questions",
    response_model=ResearchQuestionResponse,
    status_code=status.HTTP_201_CREATED,
)
def add_research_question(
    project_id: str,
    payload: OrderedTextCreate,
    admin: User = Depends(require_project_member_csrf),
    db: Session = Depends(get_db),
) -> ResearchQuestion:
    get_project(db, project_id)
    item = ResearchQuestion(
        project_id=project_id,
        text=payload.text.strip(),
        position=(
            payload.position
            if payload.position is not None
            else next_position(db, ResearchQuestion, project_id)
        ),
    )
    db.add(item)
    db.flush()
    record_audit(
        db,
        action="research_question.created",
        entity_type="research_question",
        entity_id=item.id,
        project_id=project_id,
        actor_id=admin.id,
        summary="Added research question",
    )
    db.commit()
    return item


@router.patch(
    "/{project_id}/research-questions/{item_id}",
    response_model=ResearchQuestionResponse,
)
def update_research_question(
    project_id: str,
    item_id: str,
    payload: ResearchQuestionUpdate,
    admin: User = Depends(require_project_member_csrf),
    db: Session = Depends(get_db),
) -> ResearchQuestion:
    item = db.get(ResearchQuestion, item_id)
    if item is None or item.project_id != project_id or not item.is_active:
        raise NotFoundError("Research question not found")
    item.text = payload.text.strip()
    record_audit(
        db,
        action="research_question.updated",
        entity_type="research_question",
        entity_id=item.id,
        project_id=project_id,
        actor_id=admin.id,
        summary="Updated research question",
    )
    db.commit()
    return item


@router.delete(
    "/{project_id}/research-questions/{item_id}", status_code=status.HTTP_204_NO_CONTENT
)
def delete_research_question(
    project_id: str,
    item_id: str,
    admin: User = Depends(require_project_member_csrf),
    db: Session = Depends(get_db),
) -> None:
    item = db.get(ResearchQuestion, item_id)
    if item is None or item.project_id != project_id or not item.is_active:
        raise NotFoundError("Research question not found")
    item.is_active = False
    record_audit(
        db,
        action="research_question.deleted",
        entity_type="research_question",
        entity_id=item.id,
        project_id=project_id,
        actor_id=admin.id,
        summary="Removed research question",
    )
    db.commit()


@router.post(
    "/{project_id}/criteria",
    response_model=CriterionResponse,
    status_code=status.HTTP_201_CREATED,
)
def add_criterion(
    project_id: str,
    payload: CriterionCreate,
    admin: User = Depends(require_project_member_csrf),
    db: Session = Depends(get_db),
) -> Criterion:
    get_project(db, project_id)
    item = Criterion(
        project_id=project_id,
        kind=payload.kind,
        text=payload.text.strip(),
        position=(
            payload.position
            if payload.position is not None
            else next_position(db, Criterion, project_id)
        ),
    )
    db.add(item)
    db.flush()
    record_audit(
        db,
        action="criterion.created",
        entity_type="criterion",
        entity_id=item.id,
        project_id=project_id,
        actor_id=admin.id,
        summary=f"Added {payload.kind} criterion",
    )
    db.commit()
    return item


@router.patch("/{project_id}/criteria/{item_id}", response_model=CriterionResponse)
def update_criterion(
    project_id: str,
    item_id: str,
    payload: CriterionUpdate,
    admin: User = Depends(require_project_member_csrf),
    db: Session = Depends(get_db),
) -> Criterion:
    item = db.get(Criterion, item_id)
    if item is None or item.project_id != project_id or not item.is_active:
        raise NotFoundError("Criterion not found")
    item.text = payload.text.strip()
    if payload.kind is not None:
        item.kind = payload.kind
    record_audit(
        db,
        action="criterion.updated",
        entity_type="criterion",
        entity_id=item.id,
        project_id=project_id,
        actor_id=admin.id,
        summary="Updated criterion",
    )
    db.commit()
    return item


@router.delete(
    "/{project_id}/criteria/{item_id}", status_code=status.HTTP_204_NO_CONTENT
)
def delete_criterion(
    project_id: str,
    item_id: str,
    admin: User = Depends(require_project_member_csrf),
    db: Session = Depends(get_db),
) -> None:
    item = db.get(Criterion, item_id)
    if item is None or item.project_id != project_id or not item.is_active:
        raise NotFoundError("Criterion not found")
    item.is_active = False
    record_audit(
        db,
        action="criterion.deleted",
        entity_type="criterion",
        entity_id=item.id,
        project_id=project_id,
        actor_id=admin.id,
        summary="Removed criterion",
    )
    db.commit()


@router.put(
    "/{project_id}/screening-config/{stage}", response_model=ScreeningConfigResponse
)
def set_screening_config(
    project_id: str,
    stage: ScreeningStage,
    payload: ScreeningConfigUpdate,
    admin: User = Depends(require_project_manager_csrf),
    db: Session = Depends(get_db),
) -> ScreeningConfig:
    get_project(db, project_id)
    config = db.scalar(
        select(ScreeningConfig).where(
            ScreeningConfig.project_id == project_id, ScreeningConfig.stage == stage
        )
    )
    assert config is not None
    config.required_reviewers = payload.required_reviewers
    config.allocation_mode = payload.allocation_mode
    config.conflict_resolution = payload.conflict_resolution
    config.uncertain_resolution = payload.uncertain_resolution
    record_audit(
        db,
        action="screening_config.updated",
        entity_type="screening_config",
        entity_id=config.id,
        project_id=project_id,
        actor_id=admin.id,
        summary=f"Updated {stage.value} screening configuration",
    )
    db.commit()
    return config


@router.get(
    "/{project_id}/highlight-keywords", response_model=HighlightKeywordsResponse
)
def get_highlight_keywords(
    project_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> HighlightKeywordsResponse:
    project = require_project_access(db, project_id, user)
    return HighlightKeywordsResponse(
        keywords=parse_highlight_keywords(project.highlight_keywords_raw)
    )


@router.put(
    "/{project_id}/highlight-keywords", response_model=HighlightKeywordsResponse
)
def set_highlight_keywords(
    project_id: str,
    payload: HighlightKeywordsUpdate,
    admin: User = Depends(require_project_manager_csrf),
    db: Session = Depends(get_db),
) -> HighlightKeywordsResponse:
    project = get_project(db, project_id)
    keywords = parse_highlight_keywords(serialize_highlight_keywords(payload.keywords))
    project.highlight_keywords_raw = serialize_highlight_keywords(keywords)
    record_audit(
        db,
        action="project.highlight_keywords_updated",
        entity_type="project",
        entity_id=project.id,
        project_id=project_id,
        actor_id=admin.id,
        summary="Updated highlighted keywords",
        metadata={"count": len(keywords)},
    )
    db.commit()
    return HighlightKeywordsResponse(keywords=keywords)


@router.get("/{project_id}/jobs", response_model=list[JobResponse])
def list_project_jobs(
    project_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[BackgroundJob]:
    require_project_access(db, project_id, user)
    return list(
        db.scalars(
            select(BackgroundJob)
            .where(BackgroundJob.project_id == project_id)
            .order_by(BackgroundJob.created_at.desc())
        )
    )


@router.get("/{project_id}/integrity")
def project_integrity(
    project_id: str,
    admin: User = Depends(require_project_manager_csrf),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    from app.projects.lifecycle import project_integrity_issues

    project = get_project(db, project_id)
    return {"issues": project_integrity_issues(db, project)}


@router.post("/{project_id}/reopen", response_model=ProjectSummary)
def reopen_completed_project(
    project_id: str,
    payload: ProjectReopen,
    admin: User = Depends(require_project_manager_csrf),
    db: Session = Depends(get_db),
) -> Project:
    from app.api.errors import DomainError
    from app.projects.lifecycle import reopen_project

    project = get_project(db, project_id)
    try:
        reopen_project(db, project, payload.target_stage, admin.id)
    except ValueError as exc:
        raise DomainError(str(exc)) from exc
    db.commit()
    return project


@router.post("/{project_id}/move-back", response_model=ProjectSummary)
def move_project_back_endpoint(
    project_id: str,
    payload: ProjectReopen,
    admin: User = Depends(require_project_manager_csrf),
    db: Session = Depends(get_db),
) -> Project:
    from app.api.errors import DomainError
    from app.projects.lifecycle import move_project_back

    project = get_project(db, project_id)
    try:
        move_project_back(db, project, payload.target_stage, admin.id)
    except ValueError as exc:
        raise DomainError(str(exc)) from exc
    db.commit()
    return project


@router.post("/{project_id}/reset", response_model=ProjectSummary)
def reset_project_endpoint(
    project_id: str,
    admin: User = Depends(require_project_manager_csrf),
    db: Session = Depends(get_db),
) -> Project:
    from app.projects.lifecycle import reset_project

    project = get_project(db, project_id)
    reset_project(db, project, admin.id)
    db.commit()
    return project


@router.delete("/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_project_endpoint(
    project_id: str,
    admin: User = Depends(require_project_manager_csrf),
    db: Session = Depends(get_db),
) -> None:
    from app.projects.file_cleanup import ProjectFileCleanup
    from app.projects.lifecycle import delete_project

    project = get_project(db, project_id)
    project_jobs = list(
        db.scalars(
            select(BackgroundJob)
            .where(BackgroundJob.project_id == project_id)
            .with_for_update()
        )
    )
    if any(job.status == JobStatus.RUNNING for job in project_jobs):
        raise ConflictError(
            "Wait for running background jobs to finish before deleting the project"
        )
    file_cleanup = ProjectFileCleanup.collect(db, project_id)
    delete_project(db, project)
    db.commit()
    file_cleanup.remove()
