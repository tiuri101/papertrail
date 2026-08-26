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
    ProjectStage,
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


def project_progress_stats(
    db: Session, projects: list[Project]
) -> dict[str, dict[str, Any]]:
    """Per-project card stats for the projects overview: an imports/reviewers
    count plus a stage-dependent secondary count and completion percentage.

    The secondary metric and its label change with a project's current stage
    (screened vs. duplicates found vs. extracted vs. final included count) so
    each card reads as progress toward *that* stage's finish line, not a
    generic aggregate.
    """
    from app.conflicts.models import FinalDecision
    from app.deduplication.models import DuplicateCandidate
    from app.extraction.models import ExtractionStatus, ExtractionWorkItem
    from app.publications.models import Publication
    from app.screening.cohorts import on_active_publication
    from app.screening.models import ScreeningOutcome

    if not projects:
        return {}

    project_ids = [project.id for project in projects]

    # Publications removed from the review (deleted, or merged away into a
    # canonical record) are not part of the project any more, so they must
    # not inflate the "Imported" figure or the denominators derived from it.
    imported_counts: dict[str, int] = dict(
        db.execute(
            select(Publication.project_id, func.count())
            .where(
                Publication.project_id.in_(project_ids),
                Publication.is_active.is_(True),
            )
            .group_by(Publication.project_id)
        )
        .tuples()
        .all()
    )
    reviewer_counts: dict[str, int] = dict(
        db.execute(
            select(ProjectMembership.project_id, func.count())
            .where(ProjectMembership.project_id.in_(project_ids))
            .group_by(ProjectMembership.project_id)
        )
        .tuples()
        .all()
    )
    duplicate_totals: dict[str, int] = dict(
        db.execute(
            select(DuplicateCandidate.project_id, func.count())
            .where(DuplicateCandidate.project_id.in_(project_ids))
            .group_by(DuplicateCandidate.project_id)
        )
        .tuples()
        .all()
    )
    duplicate_resolved: dict[str, int] = dict(
        db.execute(
            select(DuplicateCandidate.project_id, func.count())
            .where(
                DuplicateCandidate.project_id.in_(project_ids),
                DuplicateCandidate.status != "unresolved",
            )
            .group_by(DuplicateCandidate.project_id)
        )
        .tuples()
        .all()
    )
    duplicate_merged: dict[str, int] = dict(
        db.execute(
            select(DuplicateCandidate.project_id, func.count())
            .where(
                DuplicateCandidate.project_id.in_(project_ids),
                DuplicateCandidate.status == "merged",
            )
            .group_by(DuplicateCandidate.project_id)
        )
        .tuples()
        .all()
    )
    extraction_completed: dict[str, int] = dict(
        db.execute(
            select(ExtractionWorkItem.project_id, func.count())
            .where(
                ExtractionWorkItem.project_id.in_(project_ids),
                ExtractionWorkItem.status == ExtractionStatus.COMPLETED,
                ExtractionWorkItem.slot_number == 1,
            )
            .group_by(ExtractionWorkItem.project_id)
        )
        .tuples()
        .all()
    )

    decision_counts: dict[str, dict[tuple[str, str], int]] = {}
    for project_id, stage, outcome, count in db.execute(
        select(
            FinalDecision.project_id,
            FinalDecision.stage,
            FinalDecision.outcome,
            func.count(),
        )
        .where(
            FinalDecision.project_id.in_(project_ids),
            FinalDecision.is_valid.is_(True),
            on_active_publication(),
        )
        .group_by(FinalDecision.project_id, FinalDecision.stage, FinalDecision.outcome)
    ).all():
        decision_counts.setdefault(project_id, {})[(str(stage), str(outcome))] = int(
            count
        )

    def stage_total(project_id: str, stage: ScreeningStage) -> int:
        return sum(
            count
            for (s, _outcome), count in decision_counts.get(project_id, {}).items()
            if s == str(stage)
        )

    def stage_outcome(
        project_id: str, stage: ScreeningStage, outcome: ScreeningOutcome
    ) -> int:
        return decision_counts.get(project_id, {}).get((str(stage), str(outcome)), 0)

    stats: dict[str, dict[str, Any]] = {}
    for project in projects:
        imported = imported_counts.get(project.id, 0)
        title_abstract_screened = stage_total(project.id, ScreeningStage.TITLE_ABSTRACT)
        title_abstract_included = stage_outcome(
            project.id, ScreeningStage.TITLE_ABSTRACT, ScreeningOutcome.INCLUDE
        )
        full_text_screened = stage_total(project.id, ScreeningStage.FULL_TEXT)
        full_text_included = stage_outcome(
            project.id, ScreeningStage.FULL_TEXT, ScreeningOutcome.INCLUDE
        )
        extracted = extraction_completed.get(project.id, 0)

        if project.stage == ProjectStage.DRAFT:
            primary_label, primary_count = "Imported", imported
            secondary_label, secondary_count = "Screened", 0
            percent = 0
        elif project.stage == ProjectStage.DUPLICATE_REVIEW:
            total_candidates = duplicate_totals.get(project.id, 0)
            resolved_candidates = duplicate_resolved.get(project.id, 0)
            primary_label, primary_count = "Imported", imported
            secondary_label, secondary_count = (
                "Duplicates",
                duplicate_merged.get(project.id, 0),
            )
            percent = (
                round(resolved_candidates / total_candidates * 100)
                if total_candidates
                else 0
            )
        elif project.stage == ProjectStage.TITLE_ABSTRACT:
            primary_label, primary_count = "Imported", imported
            secondary_label, secondary_count = "Screened", title_abstract_screened
            percent = round(title_abstract_screened / imported * 100) if imported else 0
        elif project.stage == ProjectStage.FULL_TEXT:
            primary_label, primary_count = "Imported", imported
            secondary_label, secondary_count = "Screened", full_text_screened
            percent = (
                round(full_text_screened / title_abstract_included * 100)
                if title_abstract_included
                else 0
            )
        elif project.stage == ProjectStage.EXTRACTION:
            primary_label, primary_count = "Imported", imported
            secondary_label, secondary_count = "Extracted", extracted
            percent = (
                round(extracted / full_text_included * 100) if full_text_included else 0
            )
        else:  # ProjectStage.COMPLETED
            primary_label, primary_count = "Included", full_text_included
            secondary_label, secondary_count = "Screened", title_abstract_screened
            percent = 100

        stats[project.id] = {
            "primary_label": primary_label,
            "primary_count": primary_count,
            "secondary_label": secondary_label,
            "secondary_count": secondary_count,
            "reviewer_count": reviewer_counts.get(project.id, 0),
            "percent_complete": max(0, min(100, percent)),
        }
    return stats


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


class ProjectOwnershipError(ConflictError):
    """An operation would have left a project with no owner, or two.

    409 rather than 400: the request is well-formed and only conflicts with
    the project's current ownership. The distinct code lets a client offer
    Transfer Ownership instead of showing a generic error.
    """

    code = "project_ownership_required"


def project_owner_membership(
    db: Session, project_id: str, *, lock: bool = False
) -> ProjectMembership | None:
    """The project's single owner membership, if it has one.

    ``lock`` takes ``SELECT ... FOR UPDATE`` on the row so a transfer can
    read the current owner and reassign ownership without a concurrent
    transfer interleaving between the two writes. Lock ordering: this is the
    project's own membership row, taken before any publication-level lock.
    """
    query = select(ProjectMembership).where(
        ProjectMembership.project_id == project_id,
        ProjectMembership.is_owner.is_(True),
    )
    if lock and db.bind is not None and db.bind.dialect.name == "postgresql":
        query = query.with_for_update()
    return db.scalar(query)


def transfer_project_ownership(
    db: Session, project: Project, new_owner_user_id: str
) -> ProjectMembership:
    """Move ownership of a project to another of its members, atomically.

    A project has exactly one owner, which is why demoting the current owner
    and promoting a replacement cannot be two separate operations: between
    them the project would be ownerless, and ``uq_project_single_owner``
    would reject the promotion if they ran in the other order. Both writes
    happen here, in one transaction, so the project is never observed with
    zero or two owners.

    The new owner must already be a member: ownership is a role over an
    existing membership (with its own reviewer eligibility and workload
    weight), not a way to add someone to a project.
    """
    current = project_owner_membership(db, project.id, lock=True)
    target = db.scalar(
        select(ProjectMembership).where(
            ProjectMembership.project_id == project.id,
            ProjectMembership.user_id == new_owner_user_id,
        )
    )
    if target is None:
        raise NotFoundError(
            "Add that user to the project before transferring ownership to them"
        )
    if current is not None and current.id == target.id:
        raise ProjectOwnershipError("That member already owns this project")
    user = db.get(User, new_owner_user_id)
    if user is None or not user.is_active:
        raise ProjectOwnershipError(
            "Ownership cannot be transferred to a deactivated user"
        )
    if current is not None:
        current.is_owner = False
    # Flushed before the promotion so the single-owner index sees the
    # demotion first; both are still one transaction.
    db.flush()
    target.is_owner = True
    db.flush()
    return target


def remove_membership(db: Session, membership: ProjectMembership) -> None:
    """Remove a reviewer from a project.

    Refuses to remove the owner: a project with no owner has no one who can
    manage it, transfer it, or be notified about it, and nothing else in the
    application can put ownership back. Transfer ownership first, then the
    former owner can be removed like any other member.
    """
    if membership.is_owner:
        raise ProjectOwnershipError(
            "Transfer ownership to another member before removing the "
            "project owner"
        )
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
