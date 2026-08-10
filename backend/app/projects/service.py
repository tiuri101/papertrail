from __future__ import annotations

import secrets
from typing import Any

from sqlalchemy import Select, func, select
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
    db: Session,
    name: str,
    description: str | None,
    review_type: ReviewType,
    owner: User,
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
                allocation_mode=AllocationMode.CLAIM,
                conflict_resolution=ResolutionMethod.ADMIN_CONSENSUS,
                uncertain_resolution=ResolutionMethod.ADMIN_CONSENSUS,
            )
        )
    db.add(
        ProjectMembership(
            project_id=project.id,
            user_id=owner.id,
            is_owner=True,
            can_title_abstract_screen=True,
            can_full_text_screen=True,
            can_extract=True,
            can_assess_quality=True,
            can_adjudicate=True,
        )
    )
    db.flush()
    from app.notifications.service import queue_project_created_emails

    queue_project_created_emails(db, project, owner)
    return project


def project_query() -> Select[tuple[Project]]:
    return select(Project).options(
        selectinload(Project.memberships),
        selectinload(Project.research_questions),
        selectinload(Project.criteria),
        selectinload(Project.screening_configs),
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


def is_project_manager(db: Session, project_id: str, user: User) -> bool:
    """A project manager is a global admin or that project's owner."""
    if user.is_admin:
        return True
    return (
        db.scalar(
            select(ProjectMembership.id).where(
                ProjectMembership.project_id == project_id,
                ProjectMembership.user_id == user.id,
                ProjectMembership.is_owner.is_(True),
            )
        )
        is not None
    )


def is_any_project_manager(db: Session, user: User) -> bool:
    """True for a global admin, or a user who owns at least one project.

    Used for endpoints not scoped to a single project (e.g. the shared
    template catalog) that project owners still need read access to.
    """
    if user.is_admin:
        return True
    return (
        db.scalar(
            select(ProjectMembership.id).where(
                ProjectMembership.user_id == user.id,
                ProjectMembership.is_owner.is_(True),
            )
        )
        is not None
    )


def require_project_manager(db: Session, project_id: str, user: User) -> Project:
    project = get_project(db, project_id)
    if not is_project_manager(db, project_id, user):
        raise ForbiddenError("Project owner or administrator access required")
    return project


def require_manager_for(db: Session, user: User, project_id: str | None) -> None:
    """Authorize a manager-only action on an entity that may or may not belong
    to a project (e.g. a form that could be a global template)."""
    if project_id is None:
        if not user.is_admin:
            raise ForbiddenError("Administrator access required")
        return
    if not is_project_manager(db, project_id, user):
        raise ForbiddenError("Project owner or administrator access required")


def list_projects_for_user(db: Session, user: User) -> list[Project]:
    query = select(Project).order_by(Project.name)
    if not user.is_admin:
        query = query.join(ProjectMembership).where(
            ProjectMembership.user_id == user.id
        )
    return list(db.scalars(query))


def open_task_counts_for_user(
    db: Session, project_ids: list[str], user_id: str
) -> dict[str, int]:
    from app.extraction.models import ExtractionStatus, ExtractionWorkItem
    from app.quality.models import QualityStatus, QualityWorkItem
    from app.screening.models import ScreeningWorkItem, WorkItemStatus

    if not project_ids:
        return {}

    counts: dict[str, int] = {}
    screening_counts = db.execute(
        select(ScreeningWorkItem.project_id, func.count())
        .where(
            ScreeningWorkItem.project_id.in_(project_ids),
            ScreeningWorkItem.assigned_reviewer_id == user_id,
            ScreeningWorkItem.status != WorkItemStatus.SUBMITTED,
        )
        .group_by(ScreeningWorkItem.project_id)
    ).all()
    for project_id, count in screening_counts:
        counts[project_id] = int(count)

    extraction_counts = db.execute(
        select(ExtractionWorkItem.project_id, func.count())
        .where(
            ExtractionWorkItem.project_id.in_(project_ids),
            ExtractionWorkItem.assigned_reviewer_id == user_id,
            ExtractionWorkItem.status != ExtractionStatus.COMPLETED,
        )
        .group_by(ExtractionWorkItem.project_id)
    ).all()
    for project_id, count in extraction_counts:
        counts[project_id] = counts.get(project_id, 0) + int(count)

    quality_counts = db.execute(
        select(QualityWorkItem.project_id, func.count())
        .where(
            QualityWorkItem.project_id.in_(project_ids),
            QualityWorkItem.assigned_reviewer_id == user_id,
            QualityWorkItem.status != QualityStatus.COMPLETED,
        )
        .group_by(QualityWorkItem.project_id)
    ).all()
    for project_id, count in quality_counts:
        counts[project_id] = counts.get(project_id, 0) + int(count)

    return counts


def add_membership(
    db: Session, project: Project, user: User, **eligibility: bool | float
) -> ProjectMembership:
    if not user.is_active:
        raise ConflictError("Cannot add a deactivated user to a project")
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


def get_membership(db: Session, project_id: str, member_id: str) -> ProjectMembership:
    membership = db.scalar(
        select(ProjectMembership).where(
            ProjectMembership.id == member_id,
            ProjectMembership.project_id == project_id,
        )
    )
    if membership is None:
        raise NotFoundError("Project member not found")
    return membership


def update_membership(
    db: Session, membership: ProjectMembership, **eligibility: bool | float
) -> ProjectMembership:
    for field, value in eligibility.items():
        setattr(membership, field, value)
    db.flush()
    return membership


def remove_membership(db: Session, membership: ProjectMembership) -> None:
    db.delete(membership)
    db.flush()


def reviewer_weights(
    db: Session, project_id: str, reviewer_ids: list[str]
) -> dict[str, float]:
    """Each reviewer's configured workload share for a project, defaulting to 1.0
    for anyone without a membership row (e.g. a global admin filling in as a
    reviewer)."""
    if not reviewer_ids:
        return {}
    rows = db.execute(
        select(ProjectMembership.user_id, ProjectMembership.workload_weight).where(
            ProjectMembership.project_id == project_id,
            ProjectMembership.user_id.in_(reviewer_ids),
        )
    ).all()
    weights = {user_id: weight for user_id, weight in rows}
    return {reviewer_id: weights.get(reviewer_id, 1.0) for reviewer_id in reviewer_ids}


def weighted_round_robin_sequence(
    reviewer_ids: list[str], weights: dict[str, float], count: int
) -> list[str]:
    """A deterministic sequence of `count` reviewer picks, proportioned to each
    reviewer's weight, using the smooth weighted round-robin algorithm (as used
    by nginx's upstream load balancer). Reviewers are interleaved rather than
    assigned in weight-sized blocks, so consecutive publications are spread
    across reviewers even when weights differ a lot.
    """
    if not reviewer_ids:
        return []
    current = {reviewer_id: 0.0 for reviewer_id in reviewer_ids}
    total_weight = sum(
        max(weights.get(reviewer_id, 1.0), 0.01) for reviewer_id in reviewer_ids
    )
    sequence: list[str] = []
    for _ in range(count):
        for reviewer_id in reviewer_ids:
            current[reviewer_id] += max(weights.get(reviewer_id, 1.0), 0.01)
        chosen = max(reviewer_ids, key=lambda r: (current[r], -reviewer_ids.index(r)))
        sequence.append(chosen)
        current[chosen] -= total_weight
    return sequence


def parse_highlight_keywords(raw: str) -> list[str]:
    seen: dict[str, None] = {}
    for line in raw.splitlines():
        keyword = line.strip()
        if keyword:
            seen.setdefault(keyword, None)
    return list(seen)


def serialize_highlight_keywords(keywords: list[str]) -> str:
    return "\n".join(keyword.strip() for keyword in keywords if keyword.strip())


def next_position(
    db: Session,
    model: type[Any],
    project_id: str,
    *,
    stage: ScreeningStage | None = None,
) -> int:
    query = select(func.coalesce(func.max(model.position), -1) + 1).where(
        model.project_id == project_id
    )
    if stage is not None:
        query = query.where(model.stage == stage)
    return int(db.scalar(query) or 0)
