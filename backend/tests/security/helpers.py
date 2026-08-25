"""Shared fixtures for the security regression suite.

Each module here locks in one authorization rule that a real audit finding
showed was missing, so the setup helpers deliberately build the *minimum*
project that reaches the stage under test rather than reusing the broader
workflow fixtures.
"""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy.orm import Session

from app.accounts.models import User
from app.accounts.service import create_user
from app.conflicts.service import record_final_decision
from app.extraction.models import ExtractionConfig
from app.forms.models import FormField, FormKind
from app.forms.service import add_field, create_form
from app.projects.models import (
    AllocationMode,
    Project,
    ProjectMembership,
    ProjectStage,
    ReviewType,
    ScreeningConfig,
    ScreeningStage,
    TaskAllocationMode,
)
from app.publications.models import Publication
from app.quality.models import QualityConfig

ADMIN_PASSWORD = "admin-password-value"
OWNER_PASSWORD = "owner-password-value"
REVIEWER_PASSWORD = "reviewer-password-value"


@dataclass
class ReviewFixture:
    project: Project
    admin: User
    owner: User
    reviewer: User
    membership: ProjectMembership
    publications: list[Publication]
    extraction_field: FormField | None = None
    quality_field: FormField | None = None


def login(client, username: str, password: str) -> str:
    """Log in and return the CSRF token for the new session."""
    response = client.post(
        "/api/v1/auth/login",
        json={"username": username, "password": password},
    )
    assert response.status_code == 200, response.text
    return str(response.json()["csrfToken"])


def build_review_project(
    db: Session,
    *,
    can_title_abstract_screen: bool = False,
    can_full_text_screen: bool = False,
    can_extract: bool = False,
    can_assess_quality: bool = False,
    screening_allocation: AllocationMode = AllocationMode.CLAIM,
    task_allocation: TaskAllocationMode = TaskAllocationMode.CLAIM,
    with_extraction_form: bool = False,
    with_quality_form: bool = False,
    publication_count: int = 2,
    stage: ProjectStage = ProjectStage.TITLE_ABSTRACT,
) -> ReviewFixture:
    admin = create_user(db, "sec-admin", "Admin", ADMIN_PASSWORD, is_admin=True)
    owner = create_user(db, "sec-owner", "Owner", OWNER_PASSWORD)
    reviewer = create_user(db, "sec-reviewer", "Reviewer", REVIEWER_PASSWORD)
    project = Project(
        name="Security review",
        review_type=ReviewType.SYSTEMATIC_REVIEW,
        random_seed="security-seed",
        stage=stage,
    )
    db.add(project)
    db.flush()
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
    membership = ProjectMembership(
        project_id=project.id,
        user_id=reviewer.id,
        can_title_abstract_screen=can_title_abstract_screen,
        can_full_text_screen=can_full_text_screen,
        can_extract=can_extract,
        can_assess_quality=can_assess_quality,
    )
    db.add(membership)
    for screening_stage in ScreeningStage:
        db.add(
            ScreeningConfig(
                project_id=project.id,
                stage=screening_stage,
                required_reviewers=1,
                allocation_mode=screening_allocation,
            )
        )
    db.add(
        ExtractionConfig(
            project_id=project.id,
            allocation_mode=task_allocation,
            required_reviewers=1,
        )
    )
    db.add(
        QualityConfig(
            project_id=project.id,
            enabled=True,
            mode="both",
            aggregation="sum",
            allocation_mode=task_allocation,
        )
    )

    extraction_field = None
    if with_extraction_form:
        form = create_form(db, "Extraction", FormKind.EXTRACTION, project_id=project.id)
        extraction_field = add_field(db, form, "Findings", "long_text", required=True)
    quality_field = None
    if with_quality_form:
        form = create_form(db, "Quality", FormKind.QUALITY, project_id=project.id)
        quality_field = add_field(
            db,
            form,
            "Study design",
            "single_select",
            required=True,
            options=["strong", "weak"],
            scoring={"values": {"strong": 2, "weak": 0}, "weight": 1},
        )

    publications = [
        Publication(project_id=project.id, title=f"Paper {index}")
        for index in range(publication_count)
    ]
    db.add_all(publications)
    db.flush()
    db.commit()
    return ReviewFixture(
        project=project,
        admin=admin,
        owner=owner,
        reviewer=reviewer,
        membership=membership,
        publications=publications,
        extraction_field=extraction_field,
        quality_field=quality_field,
    )


def include_at_full_text(db: Session, publications: list[Publication]) -> None:
    """Mark publications finally included at full text so the extraction and
    quality queues consider them."""
    for publication in publications:
        record_final_decision(
            db,
            publication.id,
            ScreeningStage.FULL_TEXT,
            "include",
            "agreement",
            None,
            None,
        )
    db.commit()
