from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.accounts.dependencies import get_current_user, require_csrf
from app.accounts.models import User, UserSession
from app.accounts.service import get_user_or_raise
from app.api.errors import DomainError, NotFoundError
from app.audit.service import record_audit
from app.db.session import get_db
from app.imports.schemas import JobRestartRequest, JobStageSummary
from app.jobs.diagnostics import STAGE_ORDER
from app.jobs.models import BackgroundJob, JobStatus
from app.jobs.registry import JOB_STAGES
from app.jobs.schemas import JobPageResponse, JobResponse
from app.jobs.service import (
    DEFAULT_JOB_PAGE_SIZE,
    MAX_JOB_PAGE_SIZE,
    JobPage,
    cancel_project_jobs,
    jobs_page,
    restart_job,
)
from app.notifications.service import queue_membership_email
from app.projects.dependencies import (
    require_project_manager,
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
    MemberCandidate,
    MembershipCreate,
    MembershipResponse,
    MembershipUpdate,
    OrderedTextCreate,
    OwnershipTransfer,
    ProjectChecklist,
    ProjectCloneRequest,
    ProjectCreate,
    ProjectDetail,
    ProjectDetailsUpdate,
    ProjectListItem,
    ProjectOwnerSummary,
    ProjectReopen,
    ProjectSummary,
    PromptFlowSettings,
    PromptSettingsResponse,
    PromptSettingsUpdate,
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
    open_task_counts_for_user,
    parse_highlight_keywords,
    project_owner_membership,
    project_progress_stats,
    remove_membership,
    require_project_access,
    serialize_highlight_keywords,
    transfer_project_ownership,
    update_membership,
)

router = APIRouter(prefix="/projects", tags=["projects"])


@router.get("", response_model=list[ProjectListItem])
def list_projects(
    archived: bool = Query(False),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[ProjectListItem]:
    projects = list_projects_for_user(db, user, archived=archived)
    if not projects:
        return []

    project_ids = [project.id for project in projects]
    open_task_counts = open_task_counts_for_user(db, project_ids, user.id)
    progress_stats = project_progress_stats(db, projects)
    relevant_memberships = db.execute(
        select(ProjectMembership, User)
        .join(User, User.id == ProjectMembership.user_id)
        .where(
            ProjectMembership.project_id.in_(project_ids),
            or_(
                ProjectMembership.is_owner.is_(True),
                ProjectMembership.user_id == user.id,
            ),
        )
    ).all()

    owners: dict[str, ProjectOwnerSummary] = {}
    current_memberships: dict[str, ProjectMembership] = {}
    for membership, member in relevant_memberships:
        if membership.is_owner:
            owners[membership.project_id] = ProjectOwnerSummary(
                id=member.id,
                display_name=member.display_name,
            )
        if membership.user_id == user.id:
            current_memberships[membership.project_id] = membership

    results: list[ProjectListItem] = []
    for project in projects:
        membership = current_memberships.get(project.id)
        role: Literal["owner", "administrator", "reviewer"]
        if membership and membership.is_owner:
            role = "owner"
        elif user.is_admin:
            role = "administrator"
        else:
            role = "reviewer"
        stats = progress_stats.get(project.id, {})
        results.append(
            ProjectListItem(
                id=project.id,
                name=project.name,
                description=project.description,
                review_type=project.review_type,
                stage=project.stage,
                archived_at=project.archived_at,
                created_at=project.created_at,
                updated_at=project.updated_at,
                owner=owners.get(project.id),
                my_role=role,
                open_task_count=open_task_counts.get(project.id, 0),
                primary_label=stats.get("primary_label", "Imported"),
                primary_count=stats.get("primary_count", 0),
                secondary_label=stats.get("secondary_label", "Screened"),
                secondary_count=stats.get("secondary_count", 0),
                reviewer_count=stats.get("reviewer_count", 0),
                percent_complete=stats.get("percent_complete", 0),
            )
        )
    return results


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
    can_manage = is_project_manager(db, project.id, user)
    own_membership = next(
        (m for m in project.memberships if m.user_id == user.id), None
    )
    return ProjectDetail(
        id=project.id,
        name=project.name,
        description=project.description,
        review_type=project.review_type,
        stage=project.stage,
        archived_at=project.archived_at,
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
        can_manage=can_manage,
        can_manage_publications=True,
        extraction_validation_enabled=bool(
            llm_settings and llm_settings.extraction_validation_enabled
        ),
        can_title_abstract_screen=can_manage
        or bool(own_membership and own_membership.can_title_abstract_screen),
        can_full_text_screen=can_manage
        or bool(own_membership and own_membership.can_full_text_screen),
        can_extract=can_manage or bool(own_membership and own_membership.can_extract),
        can_assess_quality=can_manage
        or bool(own_membership and own_membership.can_assess_quality),
        can_adjudicate=can_manage
        or bool(own_membership and own_membership.can_adjudicate),
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
    return project_checklist(db, project, user_id=user.id)


def _reconcile_work_assignments(db: Session, project_id: str) -> None:
    """Re-run eligibility clean-up and backlog rebalancing for every stage after a
    membership change.

    First strips not-yet-completed items away from reviewers who are no longer
    eligible, then spreads each stage's unclaimed backlog evenly across whoever
    is currently eligible -- so a newly added (or newly permitted) reviewer picks
    up a fair share of pending work instead of the backlog staying stuck on
    whoever was eligible when the stage started.

    Browser-helper PDF retrieval claims are released here too: a helper paired
    to a reviewer who just lost full-text access must not keep holding this
    project's retrieval jobs until its lease expires.
    """
    from app.extraction.service import (
        reassign_work_items_from_ineligible_reviewers as reassign_extraction,
    )
    from app.extraction.service import (
        rebalance_pending_work_items as rebalance_extraction,
    )
    from app.pdf_acquisition.service import release_ineligible_claims
    from app.quality.service import (
        reassign_work_items_from_ineligible_reviewers as reassign_quality,
    )
    from app.quality.service import (
        rebalance_pending_work_items as rebalance_quality,
    )
    from app.screening.service import (
        reassign_work_items_from_ineligible_reviewers,
        rebalance_pending_work_items,
    )

    for stage in (ScreeningStage.TITLE_ABSTRACT, ScreeningStage.FULL_TEXT):
        reassign_work_items_from_ineligible_reviewers(db, project_id, stage)
        rebalance_pending_work_items(db, project_id, stage)
    reassign_extraction(db, project_id)
    rebalance_extraction(db, project_id)
    reassign_quality(db, project_id)
    rebalance_quality(db, project_id)
    release_ineligible_claims(db, project_id)


@router.get("/{project_id}/member-candidates", response_model=list[MemberCandidate])
def list_member_candidates(
    project_id: str,
    _: User = Depends(require_project_manager),
    db: Session = Depends(get_db),
) -> list[User]:
    """Users a project owner or administrator may put on this project.

    Managing membership genuinely needs to see accounts that aren't members
    yet, so this stays instance-wide -- but it is scoped to callers who
    actually manage a project, and returns only identity fields (see
    `MemberCandidate`), never email, admin status or password state.
    """
    get_project(db, project_id)
    return list(db.scalars(select(User).order_by(User.username)))


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
        workload_weight=payload.workload_weight,
    )
    record_audit(
        db,
        action="membership.created",
        entity_type="project_membership",
        entity_id=membership.id,
        project_id=project.id,
        actor_id=_.id,
        summary=f"Added reviewer {user.display_name} to project",
    )
    queue_membership_email(
        db, membership=membership, project=project, user=user, added=True
    )
    _reconcile_work_assignments(db, project_id)
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
        workload_weight=payload.workload_weight,
    )
    _reconcile_work_assignments(db, project_id)
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


@router.post("/{project_id}/transfer-ownership", response_model=ProjectDetail)
def transfer_ownership(
    project_id: str,
    payload: OwnershipTransfer,
    admin: User = Depends(require_project_manager_csrf),
    db: Session = Depends(get_db),
) -> ProjectDetail:
    """Hand the owner role to another member of this project.

    The only way ownership ever moves. Callable by the current owner or a
    global administrator (``require_project_manager_csrf``); the target must
    already be an active member, and the demotion and promotion happen in one
    transaction so the project is never ownerless.
    """
    project = get_project(db, project_id)
    previous_owner = project_owner_membership(db, project_id)
    membership = transfer_project_ownership(db, project, payload.user_id)
    new_owner = get_user_or_raise(db, membership.user_id)
    record_audit(
        db,
        action="project.ownership_transferred",
        entity_type="project",
        entity_id=project.id,
        project_id=project.id,
        actor_id=admin.id,
        summary=f"Transferred project ownership to {new_owner.display_name}",
        metadata={
            "previousOwnerUserId": (
                previous_owner.user_id if previous_owner else None
            ),
            "newOwnerUserId": membership.user_id,
        },
    )
    db.commit()
    db.refresh(project)
    return _serialize_project_detail(db, project, admin)


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
    membership_id = membership.id
    # Rejects removing the owner before anything is written, so a refused
    # removal never leaves an audit event or a queued "you were removed"
    # email behind.
    remove_membership(db, membership)
    record_audit(
        db,
        action="membership.removed",
        entity_type="project_membership",
        entity_id=membership_id,
        project_id=project_id,
        actor_id=admin.id,
        summary="Removed reviewer from project",
    )
    queue_membership_email(
        db, membership=membership, project=project, user=user, added=False
    )
    _reconcile_work_assignments(db, project_id)
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
    from app.screening.service import update_screening_config

    get_project(db, project_id)
    config = update_screening_config(
        db,
        project_id,
        stage,
        required_reviewers=payload.required_reviewers,
        allocation_mode=payload.allocation_mode,
        conflict_resolution=payload.conflict_resolution,
        uncertain_resolution=payload.uncertain_resolution,
    )
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


def _prompt_flows(db: Session, project: Project) -> list[PromptFlowSettings]:
    from app.llm.installation_settings import effective_llm_settings
    from app.llm.prompt_flows import PROMPT_FLOW_DEFAULTS, PROMPT_FLOW_LABELS

    config = effective_llm_settings(db)
    base_prompts = {
        "titleAbstract": config.llm_title_abstract_base_prompt,
        "fullText": config.llm_full_text_base_prompt,
        "extraction": config.llm_extraction_base_prompt,
        "validation": config.llm_validation_base_prompt,
    }
    instructions = {
        "titleAbstract": project.title_abstract_prompt_instructions,
        "fullText": project.full_text_prompt_instructions,
        "extraction": project.extraction_prompt_instructions,
        "validation": project.validation_prompt_instructions,
    }

    return [
        PromptFlowSettings(
            key=key,
            label=PROMPT_FLOW_LABELS[key],
            base_prompt=base_prompts[key] or PROMPT_FLOW_DEFAULTS[key],
            custom_instructions=instructions[key],
        )
        for key in PROMPT_FLOW_LABELS
    ]


@router.get("/{project_id}/prompt-settings", response_model=PromptSettingsResponse)
def get_prompt_settings(
    project_id: str,
    _: User = Depends(require_project_manager_csrf),
    db: Session = Depends(get_db),
) -> PromptSettingsResponse:
    project = get_project(db, project_id)
    return PromptSettingsResponse(flows=_prompt_flows(db, project))


@router.put("/{project_id}/prompt-settings", response_model=PromptSettingsResponse)
def set_prompt_settings(
    project_id: str,
    payload: PromptSettingsUpdate,
    admin: User = Depends(require_project_manager_csrf),
    db: Session = Depends(get_db),
) -> PromptSettingsResponse:
    project = get_project(db, project_id)
    project.extraction_prompt_instructions = payload.extraction_instructions.strip()
    project.title_abstract_prompt_instructions = (
        payload.title_abstract_instructions.strip()
    )
    project.full_text_prompt_instructions = payload.full_text_instructions.strip()
    project.validation_prompt_instructions = payload.validation_instructions.strip()
    record_audit(
        db,
        action="project.prompt_settings_updated",
        entity_type="project",
        entity_id=project.id,
        project_id=project_id,
        actor_id=admin.id,
        summary="Updated project LLM prompt instructions",
    )
    db.commit()
    return PromptSettingsResponse(flows=_prompt_flows(db, project))


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


@router.get("/{project_id}/jobs/page", response_model=JobPageResponse)
def list_project_jobs_page(
    project_id: str,
    status_filter: JobStatus | None = Query(default=None, alias="status"),
    job_type: str | None = Query(default=None, alias="jobType"),
    sort: str = "createdAt",
    direction: Literal["asc", "desc"] = "desc",
    page: int = Query(default=1, ge=1),
    page_size: int = Query(
        default=DEFAULT_JOB_PAGE_SIZE, ge=1, le=MAX_JOB_PAGE_SIZE, alias="pageSize"
    ),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> JobPage:
    """One page of a project's background jobs, filtered and ordered server-side.

    The sibling ``/jobs`` endpoint still returns the whole list for the
    short-lived pollers that watch a single just-enqueued job; this one backs
    the Jobs page, whose list is unbounded.
    """
    require_project_access(db, project_id, user)
    return jobs_page(
        db,
        project_id,
        status=status_filter,
        job_type=job_type,
        sort=sort,
        direction=direction,
        page=page,
        page_size=page_size,
    )


@router.get("/{project_id}/jobs/summary", response_model=list[JobStageSummary])
def project_jobs_summary(
    project_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[JobStageSummary]:
    require_project_access(db, project_id, user)
    rows = db.execute(
        select(BackgroundJob.job_type, BackgroundJob.status).where(
            BackgroundJob.project_id == project_id,
            BackgroundJob.status != JobStatus.CANCELLED,
        )
    ).all()

    counts: dict[str, dict[str, int]] = {}
    for job_type, job_status in rows:
        stage = JOB_STAGES.get(job_type, "Background processing")
        entry = counts.setdefault(stage, {"completed": 0, "total": 0, "active": 0})
        entry["total"] += 1
        if job_status == JobStatus.COMPLETED:
            entry["completed"] += 1
        if job_status in (JobStatus.QUEUED, JobStatus.RUNNING):
            entry["active"] += 1

    def sort_key(stage: str) -> int:
        return STAGE_ORDER.index(stage) if stage in STAGE_ORDER else len(STAGE_ORDER)

    return [
        JobStageSummary(
            stage=stage,
            completed=counts[stage]["completed"],
            total=counts[stage]["total"],
            active=counts[stage]["active"] > 0,
        )
        for stage in sorted(counts, key=sort_key)
    ]


@router.post("/{project_id}/jobs/{job_id}/restart", response_model=JobResponse)
def restart_project_job(
    project_id: str,
    job_id: str,
    admin: User = Depends(require_project_manager_csrf),
    db: Session = Depends(get_db),
) -> BackgroundJob:
    job = db.get(BackgroundJob, job_id)
    if job is None or job.project_id != project_id:
        raise NotFoundError("Job not found")
    if job.status != JobStatus.FAILED:
        raise DomainError("Only failed jobs can be restarted")
    restart_job(db, job)
    record_audit(
        db,
        action="job.restarted",
        entity_type="background_job",
        entity_id=job.id,
        project_id=project_id,
        actor_id=admin.id,
        summary=f"Restarted background job {job.job_type}",
    )
    db.commit()
    return job


@router.post("/{project_id}/jobs/restart", response_model=list[JobResponse])
def bulk_restart_project_jobs(
    project_id: str,
    payload: JobRestartRequest,
    admin: User = Depends(require_project_manager_csrf),
    db: Session = Depends(get_db),
) -> list[BackgroundJob]:
    jobs = list(
        db.scalars(
            select(BackgroundJob).where(
                BackgroundJob.project_id == project_id,
                BackgroundJob.id.in_(payload.job_ids),
                BackgroundJob.status == JobStatus.FAILED,
            )
        )
    )
    for job in jobs:
        restart_job(db, job)
        record_audit(
            db,
            action="job.restarted",
            entity_type="background_job",
            entity_id=job.id,
            project_id=project_id,
            actor_id=admin.id,
            summary=f"Restarted background job {job.job_type}",
        )
    db.commit()
    return jobs


@router.post("/{project_id}/jobs/cancel", response_model=list[JobResponse])
def cancel_all_project_jobs(
    project_id: str,
    admin: User = Depends(require_project_manager_csrf),
    db: Session = Depends(get_db),
) -> list[BackgroundJob]:
    """Cancel every queued or running background job for this project.

    Queued jobs never start; a job already running finishes its current
    handler but its result is discarded and it is not retried (see
    ``cancel_project_jobs`` and ``jobs.worker.execute_next_job``). In-flight
    LLM runs are marked cancelled too so they do not linger as "processing".
    """
    from app.llm.service import cancel_project_llm_runs
    from app.notifications.service import schedule_llm_digest_check

    cancel_project_llm_runs(db, project_id)
    jobs = cancel_project_jobs(db, project_id)
    # After cancelling, so the waiting check is not cancelled with the rest:
    # it reports whatever batch work finished before the cancellation.
    schedule_llm_digest_check(db, project_id)
    for job in jobs:
        record_audit(
            db,
            action="job.cancelled",
            entity_type="background_job",
            entity_id=job.id,
            project_id=project_id,
            actor_id=admin.id,
            summary=f"Cancelled background job {job.job_type}",
        )
    db.commit()
    return jobs


@router.get("/{project_id}/integrity")
def project_integrity(
    project_id: str,
    admin: User = Depends(require_project_manager_csrf),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    from app.projects.lifecycle import project_integrity_issues

    project = get_project(db, project_id)
    return {"issues": project_integrity_issues(db, project)}


@router.post("/{project_id}/integrity/repair")
def repair_project_integrity(
    project_id: str,
    admin: User = Depends(require_project_manager_csrf),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    from app.projects.lifecycle import reconcile_workflow_integrity

    project = get_project(db, project_id)
    result = reconcile_workflow_integrity(db, project, admin.id)
    db.commit()
    return result


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


@router.post("/{project_id}/archive", response_model=ProjectSummary)
def archive_project_endpoint(
    project_id: str,
    admin: User = Depends(require_project_manager_csrf),
    db: Session = Depends(get_db),
) -> Project:
    from app.projects.lifecycle import archive_project

    project = get_project(db, project_id)
    archive_project(db, project, admin)
    db.commit()
    return project


@router.post("/{project_id}/unarchive", response_model=ProjectSummary)
def unarchive_project_endpoint(
    project_id: str,
    admin: User = Depends(require_project_manager_csrf),
    db: Session = Depends(get_db),
) -> Project:
    from app.projects.lifecycle import unarchive_project

    project = get_project(db, project_id)
    unarchive_project(db, project, admin.id)
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


@router.post(
    "/{project_id}/clone",
    response_model=JobResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
def clone_project_endpoint(
    project_id: str,
    payload: ProjectCloneRequest,
    admin: User = Depends(require_project_manager_csrf),
    db: Session = Depends(get_db),
) -> BackgroundJob:
    """Queue a deep copy of the project; the job's result names the new one."""
    from app.projects.cloning import enqueue_project_clone

    project = get_project(db, project_id)
    job = enqueue_project_clone(db, project, name=payload.name, actor=admin)
    db.commit()
    return job


@router.post("/{project_id}/reset", response_model=ProjectSummary)
def reset_project_endpoint(
    project_id: str,
    admin: User = Depends(require_project_manager_csrf),
    db: Session = Depends(get_db),
) -> Project:
    from app.projects.file_cleanup import ProjectFileCleanup
    from app.projects.lifecycle import reset_project

    project = get_project(db, project_id)
    # Reset erases every publication, import and export the project has, so
    # it orphans exactly the same files a delete does. Collect their paths
    # while the rows naming them still exist; remove them after the commit.
    file_cleanup = ProjectFileCleanup.collect(db, project_id)
    reset_project(db, project, admin.id)
    db.commit()
    file_cleanup.remove()
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
    # Collected before the rows that name these paths are deleted, removed
    # only after the delete has been committed -- see ProjectFileCleanup.
    file_cleanup = ProjectFileCleanup.collect(db, project_id)
    delete_project(db, project)
    db.commit()
    file_cleanup.remove()
