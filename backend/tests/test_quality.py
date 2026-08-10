import pytest
from sqlalchemy import select

from app.accounts.service import create_user
from app.api.errors import ForbiddenError
from app.conflicts.service import record_final_decision
from app.forms.models import FormKind
from app.forms.service import add_field, create_form
from app.projects.models import (
    Project,
    ProjectMembership,
    ProjectStage,
    ReviewType,
    ScreeningStage,
    TaskAllocationMode,
)
from app.publications.models import Publication
from app.quality.models import (
    QualityConfig,
    QualityResponse,
    QualityStatus,
    QualityWorkItem,
)
from app.quality.service import (
    claim_next_quality,
    initialize_quality,
    reassign_work_items_from_ineligible_reviewers,
    save_draft,
    submit_quality,
)


def setup_quality(db, enabled=True):
    create_user(db, "admin", "Admin", "secret-password", is_admin=True)
    reviewer = create_user(db, "reviewer", "Reviewer", "reviewer-password")
    project = Project(
        name="Review",
        review_type=ReviewType.SYSTEMATIC_REVIEW,
        random_seed="seed",
        stage=ProjectStage.EXTRACTION,
    )
    db.add(project)
    db.flush()
    db.add(
        ProjectMembership(
            project_id=project.id, user_id=reviewer.id, can_assess_quality=True
        )
    )
    db.add(
        QualityConfig(
            project_id=project.id,
            enabled=enabled,
            mode="both",
            aggregation="weighted_average",
        )
    )
    form = create_form(db, "Quality", FormKind.QUALITY, project_id=project.id)
    design = add_field(
        db,
        form,
        "Study design",
        "single_select",
        required=True,
        options=["strong", "weak"],
        scoring={"values": {"strong": 2, "weak": 0}, "weight": 2},
    )
    reporting = add_field(
        db, form, "Reporting", "rating", required=True, scoring={"weight": 1}
    )
    publication = Publication(project_id=project.id, title="Included")
    db.add(publication)
    db.flush()
    record_final_decision(
        db, publication.id, ScreeningStage.FULL_TEXT, "include", "agreement", None, None
    )
    db.commit()
    return project, form, design, reporting, reviewer, publication


def set_pre_assigned(db, project) -> None:
    """Quality defaults to claim mode; opt a test into pre-assignment when
    that's specifically what it exercises."""
    config = db.scalar(
        select(QualityConfig).where(QualityConfig.project_id == project.id)
    )
    config.allocation_mode = TaskAllocationMode.PRE_ASSIGNED
    db.commit()


def test_disabled_quality_assessment_creates_no_work(db) -> None:
    project, *_ = setup_quality(db, enabled=False)
    assert initialize_quality(db, project) == 0
    assert list(db.scalars(select(QualityWorkItem))) == []


def test_quality_assignment_and_weighted_score(db) -> None:
    project, _, design, reporting, reviewer, _ = setup_quality(db)
    assert initialize_quality(db, project) == 1
    db.commit()
    item = claim_next_quality(db, project.id, reviewer.id)
    response = submit_quality(
        db, item, reviewer.id, {design.stable_key: "strong", reporting.stable_key: 4}
    )
    db.commit()
    assert response.total_score == pytest.approx((2 * 2 + 4 * 1) / 3)
    assert item.status == "completed"


def test_quality_save_draft_persists_and_locks_after_submission(db) -> None:
    project, _, design, reporting, reviewer, _ = setup_quality(db)
    other_reviewer = create_user(db, "other", "Other", "other-password")
    initialize_quality(db, project)
    db.commit()
    item = claim_next_quality(db, project.id, reviewer.id)

    save_draft(item, reviewer.id, {design.stable_key: "strong"})
    db.commit()
    db.refresh(item)
    assert item.draft == {design.stable_key: "strong"}

    with pytest.raises(ForbiddenError):
        save_draft(item, other_reviewer.id, {design.stable_key: "weak"})

    submit_quality(
        db, item, reviewer.id, {design.stable_key: "strong", reporting.stable_key: 4}
    )
    db.commit()
    with pytest.raises(ForbiddenError):
        save_draft(item, reviewer.id, {design.stable_key: "weak"})


def test_quality_revision_preserves_old_response(db) -> None:
    project, _, design, reporting, reviewer, _ = setup_quality(db)
    initialize_quality(db, project)
    db.commit()
    item = claim_next_quality(db, project.id, reviewer.id)
    first = submit_quality(
        db, item, reviewer.id, {design.stable_key: "weak", reporting.stable_key: 1}
    )
    second = submit_quality(
        db, item, reviewer.id, {design.stable_key: "strong", reporting.stable_key: 5}
    )
    db.commit()
    responses = list(
        db.scalars(
            select(QualityResponse)
            .where(QualityResponse.work_item_id == item.id)
            .order_by(QualityResponse.version)
        )
    )
    assert [r.version for r in responses] == [1, 2]
    assert first.is_current is False and second.is_current is True


def test_removing_a_reviewer_reassigns_their_pending_quality_item(client, db) -> None:
    project, _, _, _, reviewer, _ = setup_quality(db)
    set_pre_assigned(db, project)
    initialize_quality(db, project)
    db.commit()
    membership = db.scalar(
        select(ProjectMembership).where(
            ProjectMembership.project_id == project.id,
            ProjectMembership.user_id == reviewer.id,
        )
    )

    login = client.post(
        "/api/v1/auth/login", json={"username": "admin", "password": "secret-password"}
    )
    csrf = login.json()["csrfToken"]
    response = client.delete(
        f"/api/v1/projects/{project.id}/members/{membership.id}",
        headers={"X-CSRF-Token": csrf},
    )
    assert response.status_code == 204

    item = db.scalar(
        select(QualityWorkItem).where(QualityWorkItem.project_id == project.id)
    )
    assert item.assigned_reviewer_id != reviewer.id
    assert item.status == QualityStatus.AVAILABLE


def test_revoking_quality_permission_reassigns_work_items(client, db) -> None:
    project, _, _, _, reviewer, _ = setup_quality(db)
    set_pre_assigned(db, project)
    initialize_quality(db, project)
    db.commit()
    membership = db.scalar(
        select(ProjectMembership).where(
            ProjectMembership.project_id == project.id,
            ProjectMembership.user_id == reviewer.id,
        )
    )

    login = client.post(
        "/api/v1/auth/login", json={"username": "admin", "password": "secret-password"}
    )
    csrf = login.json()["csrfToken"]
    response = client.patch(
        f"/api/v1/projects/{project.id}/members/{membership.id}",
        json={"canAssessQuality": False},
        headers={"X-CSRF-Token": csrf},
    )
    assert response.status_code == 200

    item = db.scalar(
        select(QualityWorkItem).where(QualityWorkItem.project_id == project.id)
    )
    assert item.assigned_reviewer_id != reviewer.id


def test_completed_quality_items_are_not_reassigned(db) -> None:
    project, _, design, reporting, reviewer, _ = setup_quality(db)
    initialize_quality(db, project)
    db.commit()
    item = claim_next_quality(db, project.id, reviewer.id)
    submit_quality(
        db, item, reviewer.id, {design.stable_key: "strong", reporting.stable_key: 4}
    )
    db.commit()

    membership = db.scalar(
        select(ProjectMembership).where(
            ProjectMembership.project_id == project.id,
            ProjectMembership.user_id == reviewer.id,
        )
    )
    db.delete(membership)
    db.commit()

    reassigned = reassign_work_items_from_ineligible_reviewers(db, project.id)
    db.commit()

    assert reassigned == 0
    db.refresh(item)
    assert item.assigned_reviewer_id == reviewer.id
    assert item.status == QualityStatus.COMPLETED


def login(client, username, password) -> str:
    response = client.post(
        "/api/v1/auth/login", json={"username": username, "password": password}
    )
    return response.json()["csrfToken"]


def test_quality_config_endpoint_reads_defaults_then_the_written_settings(
    client, db
) -> None:
    create_user(db, "admin", "Admin", "secret-password", is_admin=True)
    project = Project(
        name="Review", review_type=ReviewType.SYSTEMATIC_REVIEW, random_seed="seed"
    )
    db.add(project)
    db.commit()
    csrf = login(client, "admin", "secret-password")

    defaults = client.get(
        f"/api/v1/projects/{project.id}/quality-config", headers={"X-CSRF-Token": csrf}
    )
    assert defaults.status_code == 200
    assert defaults.json() == {
        "enabled": False,
        "mode": "both",
        "aggregation": "sum",
        "allocationMode": "claim",
    }

    updated = client.put(
        f"/api/v1/projects/{project.id}/quality-config",
        json={
            "enabled": True,
            "mode": "numeric",
            "aggregation": "weighted_average",
            "allocationMode": "pre_assigned",
        },
        headers={"X-CSRF-Token": csrf},
    )
    assert updated.status_code == 200

    fetched = client.get(
        f"/api/v1/projects/{project.id}/quality-config", headers={"X-CSRF-Token": csrf}
    )
    assert fetched.json() == {
        "enabled": True,
        "mode": "numeric",
        "aggregation": "weighted_average",
        "allocationMode": "pre_assigned",
    }


def test_next_quality_endpoint_returns_the_publication_and_active_fields(
    client, db
) -> None:
    project, _, design, reporting, reviewer, publication = setup_quality(db)
    initialize_quality(db, project)
    db.commit()
    csrf = login(client, "reviewer", "reviewer-password")

    response = client.post(
        f"/api/v1/projects/{project.id}/quality/next", headers={"X-CSRF-Token": csrf}
    )
    assert response.status_code == 200
    body = response.json()
    assert body["publicationId"] == publication.id
    assert body["publication"]["title"] == "Included"
    assert {field["stableKey"] for field in body["fields"]} == {
        design.stable_key,
        reporting.stable_key,
    }

    empty = client.post(
        f"/api/v1/projects/{project.id}/quality/next", headers={"X-CSRF-Token": csrf}
    )
    assert empty.status_code == 200
    assert empty.json() is None


def test_progress_endpoint_reports_assigned_and_completed_counts(client, db) -> None:
    project, _, design, reporting, reviewer, _ = setup_quality(db)
    set_pre_assigned(db, project)
    initialize_quality(db, project)
    db.commit()
    csrf = login(client, "reviewer", "reviewer-password")

    before = client.get(
        f"/api/v1/projects/{project.id}/quality/progress",
        headers={"X-CSRF-Token": csrf},
    )
    assert before.status_code == 200
    assert before.json() == {
        "assigned": 1,
        "completed": 0,
        "remaining": 0,
        "claimMode": False,
    }

    item = claim_next_quality(db, project.id, reviewer.id)
    submit_quality(
        db, item, reviewer.id, {design.stable_key: "strong", reporting.stable_key: 4}
    )
    db.commit()

    after = client.get(
        f"/api/v1/projects/{project.id}/quality/progress",
        headers={"X-CSRF-Token": csrf},
    )
    assert after.status_code == 200
    assert after.json() == {
        "assigned": 1,
        "completed": 1,
        "remaining": 0,
        "claimMode": False,
    }


def test_progress_endpoint_reports_remaining_in_claim_mode(client, db) -> None:
    project, _, design, reporting, reviewer, _ = setup_quality(db)
    initialize_quality(db, project)
    db.commit()
    csrf = login(client, "reviewer", "reviewer-password")

    before = client.get(
        f"/api/v1/projects/{project.id}/quality/progress",
        headers={"X-CSRF-Token": csrf},
    )
    assert before.status_code == 200
    assert before.json() == {
        "assigned": 0,
        "completed": 0,
        "remaining": 1,
        "claimMode": True,
    }

    item = claim_next_quality(db, project.id, reviewer.id)
    submit_quality(
        db, item, reviewer.id, {design.stable_key: "strong", reporting.stable_key: 4}
    )
    db.commit()

    after = client.get(
        f"/api/v1/projects/{project.id}/quality/progress",
        headers={"X-CSRF-Token": csrf},
    )
    assert after.status_code == 200
    assert after.json() == {
        "assigned": 1,
        "completed": 1,
        "remaining": 0,
        "claimMode": True,
    }


def test_mine_endpoint_lists_only_the_callers_completed_assessments(client, db) -> None:
    project, _, design, reporting, reviewer, _ = setup_quality(db)
    other_reviewer = create_user(db, "other", "Other", "other-password")
    db.add(
        ProjectMembership(
            project_id=project.id, user_id=other_reviewer.id, can_assess_quality=True
        )
    )
    initialize_quality(db, project)
    db.commit()
    item = claim_next_quality(db, project.id, reviewer.id)
    submit_quality(
        db, item, reviewer.id, {design.stable_key: "strong", reporting.stable_key: 4}
    )
    db.commit()

    csrf = login(client, "reviewer", "reviewer-password")
    mine = client.get(
        f"/api/v1/projects/{project.id}/quality/mine", headers={"X-CSRF-Token": csrf}
    )
    assert mine.status_code == 200
    body = mine.json()
    assert len(body) == 1
    assert body[0]["id"] == item.id
    assert body[0]["version"] == 1

    other_csrf = login(client, "other", "other-password")
    other_mine = client.get(
        f"/api/v1/projects/{project.id}/quality/mine",
        headers={"X-CSRF-Token": other_csrf},
    )
    assert other_mine.status_code == 200
    assert other_mine.json() == []


def test_completed_quality_assessment_can_be_revisited_and_resubmitted(
    client, db
) -> None:
    project, _, design, reporting, reviewer, _ = setup_quality(db)
    other_reviewer = create_user(db, "other", "Other", "other-password")
    db.add(
        ProjectMembership(
            project_id=project.id, user_id=other_reviewer.id, can_assess_quality=True
        )
    )
    initialize_quality(db, project)
    db.commit()
    item = claim_next_quality(db, project.id, reviewer.id)
    submit_quality(
        db, item, reviewer.id, {design.stable_key: "weak", reporting.stable_key: 1}
    )
    db.commit()

    csrf = login(client, "reviewer", "reviewer-password")
    fetched = client.get(
        f"/api/v1/projects/{project.id}/quality/{item.id}",
        headers={"X-CSRF-Token": csrf},
    )
    assert fetched.status_code == 200
    assert fetched.json()["currentResponse"]["answers"] == {
        design.stable_key: "weak",
        reporting.stable_key: 1,
    }

    corrected = client.post(
        f"/api/v1/projects/{project.id}/quality/{item.id}",
        json={"answers": {design.stable_key: "strong", reporting.stable_key: 5}},
        headers={"X-CSRF-Token": csrf},
    )
    assert corrected.status_code == 200
    assert corrected.json()["version"] == 2

    other_csrf = login(client, "other", "other-password")
    forbidden = client.get(
        f"/api/v1/projects/{project.id}/quality/{item.id}",
        headers={"X-CSRF-Token": other_csrf},
    )
    assert forbidden.status_code == 403
