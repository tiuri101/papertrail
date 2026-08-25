"""Mutating a full-text retrieval requires actually holding its claim.

Audit finding: `ensure_retrieval_claim` only rejected a claim held by *someone
else*, so any reviewer eligible for full-text work could resolve an unclaimed
(or expired-claim) retrieval straight through the API -- the queue's
one-reviewer-per-paper guarantee rested entirely on the UI walking reviewers
through `claim_next_retrieval` first.
"""

from __future__ import annotations

from datetime import timedelta

import pytest
from sqlalchemy import select

from app.accounts.service import create_user
from app.api.errors import ForbiddenError
from app.conflicts.service import record_final_decision
from app.core.time import utcnow
from app.fulltext.models import FullTextRetrieval, RetrievalStatus
from app.fulltext.service import (
    claim_next_retrieval,
    initialize_full_text_stage,
    resolve_retrieval,
)
from app.projects.models import (
    AllocationMode,
    Project,
    ProjectMembership,
    ProjectStage,
    ReviewType,
    ScreeningConfig,
    ScreeningStage,
)
from app.publications.models import Publication

REVIEWER_PASSWORD = "reviewer-password-value"
OWNER_PASSWORD = "owner-password-value"


def build_retrieval_project(db):
    owner = create_user(db, "ft-owner", "Owner", OWNER_PASSWORD)
    reviewer_a = create_user(db, "ft-a", "Reviewer A", REVIEWER_PASSWORD)
    reviewer_b = create_user(db, "ft-b", "Reviewer B", REVIEWER_PASSWORD)
    project = Project(
        name="Retrieval",
        review_type=ReviewType.SYSTEMATIC_REVIEW,
        random_seed="seed",
        stage=ProjectStage.FULL_TEXT,
    )
    db.add(project)
    db.flush()
    db.add(
        ProjectMembership(
            project_id=project.id,
            user_id=owner.id,
            is_owner=True,
            can_full_text_screen=True,
        )
    )
    for reviewer in (reviewer_a, reviewer_b):
        db.add(
            ProjectMembership(
                project_id=project.id,
                user_id=reviewer.id,
                can_full_text_screen=True,
            )
        )
    db.add(
        ScreeningConfig(
            project_id=project.id,
            stage=ScreeningStage.FULL_TEXT,
            required_reviewers=1,
            allocation_mode=AllocationMode.CLAIM,
        )
    )
    publication = Publication(project_id=project.id, title="Included paper")
    db.add(publication)
    db.flush()
    record_final_decision(
        db,
        publication.id,
        ScreeningStage.TITLE_ABSTRACT,
        "include",
        "agreement",
        None,
        None,
    )
    initialize_full_text_stage(db, project)
    db.commit()
    retrieval = db.scalar(
        select(FullTextRetrieval).where(
            FullTextRetrieval.publication_id == publication.id
        )
    )
    assert retrieval is not None
    return project, owner, reviewer_a, reviewer_b, retrieval


def login(client, username: str, password: str) -> str:
    response = client.post(
        "/api/v1/auth/login", json={"username": username, "password": password}
    )
    assert response.status_code == 200, response.text
    return str(response.json()["csrfToken"])


def test_eligible_reviewer_cannot_update_an_unclaimed_retrieval(client, db) -> None:
    project, _, reviewer_a, _, retrieval = build_retrieval_project(db)
    assert retrieval.claimed_by_id is None

    with pytest.raises(ForbiddenError):
        resolve_retrieval(
            db, retrieval, RetrievalStatus.NOT_FOUND, user_id=reviewer_a.id
        )

    csrf = login(client, reviewer_a.username, REVIEWER_PASSWORD)
    response = client.put(
        f"/api/v1/projects/{project.id}/full-text/{retrieval.id}",
        json={"status": "not_found", "note": None, "decision": None},
        headers={"X-CSRF-Token": csrf},
    )
    assert response.status_code == 403, response.text

    db.expire_all()
    refreshed = db.get(FullTextRetrieval, retrieval.id)
    assert refreshed.status == RetrievalStatus.NOT_YET_SOUGHT


def test_reviewer_cannot_update_a_retrieval_claimed_by_someone_else(db) -> None:
    project, _, reviewer_a, reviewer_b, retrieval = build_retrieval_project(db)
    claim_next_retrieval(db, project.id, reviewer_a.id)
    db.commit()

    with pytest.raises(ForbiddenError):
        resolve_retrieval(
            db, retrieval, RetrievalStatus.NOT_FOUND, user_id=reviewer_b.id
        )
    assert retrieval.status == RetrievalStatus.NOT_YET_SOUGHT


def test_reviewer_cannot_update_after_their_own_claim_expired(db) -> None:
    project, _, reviewer_a, _, retrieval = build_retrieval_project(db)
    claim_next_retrieval(db, project.id, reviewer_a.id)
    retrieval.claimed_until = utcnow() - timedelta(minutes=1)
    db.commit()

    with pytest.raises(ForbiddenError):
        resolve_retrieval(
            db, retrieval, RetrievalStatus.NOT_FOUND, user_id=reviewer_a.id
        )
    assert retrieval.status == RetrievalStatus.NOT_YET_SOUGHT


def test_reviewer_holding_a_valid_claim_can_update(client, db) -> None:
    project, _, reviewer_a, _, retrieval = build_retrieval_project(db)

    csrf = login(client, reviewer_a.username, REVIEWER_PASSWORD)
    claimed = client.post(
        f"/api/v1/projects/{project.id}/full-text/next",
        headers={"X-CSRF-Token": csrf},
    )
    assert claimed.status_code == 200
    assert claimed.json()["id"] == retrieval.id

    response = client.put(
        f"/api/v1/projects/{project.id}/full-text/{retrieval.id}",
        json={"status": "not_found", "note": "No copy located", "decision": None},
        headers={"X-CSRF-Token": csrf},
    )
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "not_found"


def test_project_manager_may_update_an_unclaimed_retrieval(client, db) -> None:
    """The manager override is deliberate: owners administer the queue and
    correct records nobody has picked up."""
    project, owner, _, _, retrieval = build_retrieval_project(db)
    assert retrieval.claimed_by_id is None

    csrf = login(client, owner.username, OWNER_PASSWORD)
    response = client.put(
        f"/api/v1/projects/{project.id}/full-text/{retrieval.id}",
        json={"status": "inaccessible", "note": "Paywalled", "decision": None},
        headers={"X-CSRF-Token": csrf},
    )
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "inaccessible"
