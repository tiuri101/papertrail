from __future__ import annotations

import secrets

from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from app.accounts.models import User
from app.api.errors import ConflictError, ForbiddenError, NotFoundError
from app.projects.models import (
    AllocationMode,
    Project,
    ProjectMembership,
    ResolutionMethod,
    ReviewType,
    ScreeningConfig,
    ScreeningStage,
)


def create_project(
    db: Session, name: str, description: str | None, review_type: ReviewType
) -> Project:
    project = Project(
        name=name.strip(),
        description=description,
        review_type=review_type,
        random_seed=secrets.token_hex(32),
    )
    db.add(project)
    db.flush()
    for stage in ScreeningStage:
        db.add(
            ScreeningConfig(
                project_id=project.id,
                stage=stage,
                required_reviewers=1,
                allocation_mode=AllocationMode.DIVIDED,
                conflict_resolution=ResolutionMethod.ADMIN_CONSENSUS,
                uncertain_resolution=ResolutionMethod.ADMIN_CONSENSUS,
            )
        )
    db.flush()
    return project


def project_query():
    return select(Project).options(
        selectinload(Project.memberships),
        selectinload(Project.research_questions),
        selectinload(Project.criteria),
        selectinload(Project.screening_configs),
        selectinload(Project.exclusion_reasons),
    )


def get_project(db: Session, project_id: str) -> Project:
    project = db.scalar(project_query().where(Project.id == project_id))
    if project is None:
        raise NotFoundError("Project not found")
    return project


def require_project_access(db: Session, project_id: str, user: User) -> Project:
    project = get_project(db, project_id)
    if user.is_admin:
        return project
    if not any(m.user_id == user.id for m in project.memberships):
        raise ForbiddenError("Project membership required")
    return project


def list_projects_for_user(db: Session, user: User) -> list[Project]:
    query = select(Project).order_by(Project.name)
    if not user.is_admin:
        query = query.join(ProjectMembership).where(
            ProjectMembership.user_id == user.id
        )
    return list(db.scalars(query))


def add_membership(
    db: Session, project: Project, user: User, **eligibility: bool
) -> ProjectMembership:
    existing = db.scalar(
        select(ProjectMembership).where(
            ProjectMembership.project_id == project.id,
            ProjectMembership.user_id == user.id,
        )
    )
    if existing:
        raise ConflictError("User is already a project member")
    membership = ProjectMembership(
        project_id=project.id, user_id=user.id, **eligibility
    )
    db.add(membership)
    db.flush()
    return membership


def next_position(
    db: Session, model: type, project_id: str, *, stage: ScreeningStage | None = None
) -> int:
    query = select(func.coalesce(func.max(model.position), -1) + 1).where(
        model.project_id == project_id
    )
    if stage is not None:
        query = query.where(model.stage == stage)
    return int(db.scalar(query) or 0)
