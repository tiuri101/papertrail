"""Shared reviewer-capability checks for the screening, extraction and
quality queues.

Every reviewer-facing mutation -- claim next work, resume, save a draft,
release, submit -- must re-derive the caller's *current* right to work this
review stage on this project. Nothing else is a substitute:

* an assignment outlives the capability that created it, so "this item is
  assigned to me" proves only that someone was eligible at creation time;
* claim-mode queues deliberately hand unassigned items to whoever asks, so
  project membership alone would let any member pick up any stage's work;
* the periodic `reassign_*_from_ineligible_reviewers` sweeps are a fairness
  mechanism, not an authorization boundary -- they only run when someone
  fetches a queue, and they never look at an item a reviewer is holding.

The capability lives on `ProjectMembership`. A global administrator and a
project owner are treated as capable of every stage: both can already
override, reopen and reassign any item in the project, and the pre-existing
`require_full_text_reviewer_csrf` dependency granted them the same way, so
gating them here would break manager workflows without removing any power.
"""

from __future__ import annotations

from enum import StrEnum

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.accounts.models import User
from app.api.errors import ForbiddenError
from app.projects.models import ProjectMembership, ScreeningStage


class ReviewCapability(StrEnum):
    """A reviewer capability flag on `ProjectMembership`.

    The value is the model attribute name, so the flag is looked up in one
    place instead of being re-mapped per domain.
    """

    TITLE_ABSTRACT_SCREENING = "can_title_abstract_screen"
    FULL_TEXT_SCREENING = "can_full_text_screen"
    EXTRACTION = "can_extract"
    QUALITY = "can_assess_quality"


_DENIAL_MESSAGES: dict[ReviewCapability, str] = {
    ReviewCapability.TITLE_ABSTRACT_SCREENING: (
        "Title/abstract screening access required"
    ),
    ReviewCapability.FULL_TEXT_SCREENING: "Full-text screening access required",
    ReviewCapability.EXTRACTION: "Data extraction access required",
    ReviewCapability.QUALITY: "Quality assessment access required",
}

_STAGE_CAPABILITIES: dict[ScreeningStage, ReviewCapability] = {
    ScreeningStage.TITLE_ABSTRACT: ReviewCapability.TITLE_ABSTRACT_SCREENING,
    ScreeningStage.FULL_TEXT: ReviewCapability.FULL_TEXT_SCREENING,
}


def capability_for_stage(stage: ScreeningStage) -> ReviewCapability:
    return _STAGE_CAPABILITIES[stage]


def has_reviewer_capability(
    db: Session, project_id: str, user: User, capability: ReviewCapability
) -> bool:
    """Whether `user` may currently perform `capability` on this project."""
    if not user.is_active:
        return False
    if user.is_admin:
        return True
    membership = db.scalar(
        select(ProjectMembership).where(
            ProjectMembership.project_id == project_id,
            ProjectMembership.user_id == user.id,
        )
    )
    if membership is None:
        return False
    if membership.is_owner:
        return True
    return bool(getattr(membership, capability.value))


def require_reviewer_capability(
    db: Session, project_id: str, user: User, capability: ReviewCapability
) -> User:
    if not has_reviewer_capability(db, project_id, user, capability):
        raise ForbiddenError(_DENIAL_MESSAGES[capability])
    return user


def require_reviewer_capability_by_id(
    db: Session, project_id: str, reviewer_id: str, capability: ReviewCapability
) -> User:
    """Capability check for service functions that only carry a reviewer id.

    A reviewer id that no longer resolves to a user is refused the same way
    an ineligible one is -- callers must never fall through to the mutation.
    """
    user = db.get(User, reviewer_id)
    if user is None:
        raise ForbiddenError(_DENIAL_MESSAGES[capability])
    return require_reviewer_capability(db, project_id, user, capability)
