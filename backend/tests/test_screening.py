from datetime import UTC, datetime

import pytest
from sqlalchemy import select

from app.accounts.service import create_user
from app.api.errors import DomainError
from app.projects.models import (
    AllocationMode,
    Criterion,
    CriterionKind,
    Project,
    ProjectMembership,
    ProjectStage,
    ReviewType,
    ScreeningConfig,
    ScreeningStage,
)
from app.publications.models import Publication
from app.screening.models import ScreeningDecision, ScreeningWorkItem
from app.screening.service import (
    claim_next_work_item,
    create_screening_work_items,
    decisions_visible,
    my_submitted_work_items,
    stage_completed,
    submit_decision,
)


def setup_screening(db):
    reviewer1 = create_user(db, "reviewer1", "Reviewer 1", "password-1")
    reviewer2 = create_user(db, "reviewer2", "Reviewer 2", "password-2")
    project = Project(
        name="Review",
        review_type=ReviewType.SYSTEMATIC_REVIEW,
        random_seed="global-seed",
        stage=ProjectStage.TITLE_ABSTRACT,
    )
    db.add(project)
    db.flush()
    for reviewer in (reviewer1, reviewer2):
        db.add(
            ProjectMembership(
                project_id=project.id,
                user_id=reviewer.id,
                can_title_abstract_screen=True,
            )
        )
    config = ScreeningConfig(
        project_id=project.id,
        stage=ScreeningStage.TITLE_ABSTRACT,
        required_reviewers=2,
        allocation_mode=AllocationMode.INDEPENDENT,
    )
    db.add(config)
    criterion1 = Criterion(
        project_id=project.id,
        kind=CriterionKind.INCLUSION,
        text="Relevant topic",
        position=0,
    )
    criterion2 = Criterion(
        project_id=project.id,
        kind=CriterionKind.EXCLUSION,
        text="Wrong publication type",
        position=1,
    )
    publication = Publication(project_id=project.id, title="Paper", abstract="Abstract")
    db.add_all([criterion1, criterion2, publication])
    db.commit()
    return project, publication, reviewer1, reviewer2, [criterion1, criterion2]


def test_queue_claims_independent_slots_and_uses_deterministic_rank(db) -> None:
    project, publication, reviewer1, reviewer2, _ = setup_screening(db)
    assert create_screening_work_items(db, project, ScreeningStage.TITLE_ABSTRACT) == 2
    db.commit()
    items = list(
        db.scalars(select(ScreeningWorkItem).order_by(ScreeningWorkItem.slot_number))
    )
    assert len({item.random_rank for item in items}) == 1

    first = claim_next_work_item(
        db, project.id, ScreeningStage.TITLE_ABSTRACT, reviewer1.id
    )
    db.commit()
    assert first is not None
    assert first.reserved_until > datetime.now(UTC)
    assert (
        claim_next_work_item(
            db, project.id, ScreeningStage.TITLE_ABSTRACT, reviewer1.id
        )
        is None
    )

    second = claim_next_work_item(
        db, project.id, ScreeningStage.TITLE_ABSTRACT, reviewer2.id
    )
    assert second is not None
    assert second.publication_id == publication.id
    assert second.id != first.id


def test_submission_requires_all_criteria_and_hides_decisions_until_complete(
    db,
) -> None:
    project, _, reviewer1, reviewer2, criteria = setup_screening(db)
    create_screening_work_items(db, project, ScreeningStage.TITLE_ABSTRACT)
    db.commit()
    first = claim_next_work_item(
        db, project.id, ScreeningStage.TITLE_ABSTRACT, reviewer1.id
    )
    second = claim_next_work_item(
        db, project.id, ScreeningStage.TITLE_ABSTRACT, reviewer2.id
    )
    db.commit()

    with pytest.raises(DomainError):
        submit_decision(
            db, first, reviewer1.id, "include", {criteria[0].id: True}, None
        )
    decision1 = submit_decision(
        db,
        first,
        reviewer1.id,
        "include",
        {criteria[0].id: True, criteria[1].id: False},
        None,
    )
    db.commit()
    assert (
        decisions_visible(db, first.publication_id, ScreeningStage.TITLE_ABSTRACT)
        is False
    )

    decision2 = submit_decision(
        db,
        second,
        reviewer2.id,
        "exclude",
        {criteria[0].id: False, criteria[1].id: True},
        None,
    )
    db.commit()
    assert (
        decisions_visible(db, second.publication_id, ScreeningStage.TITLE_ABSTRACT)
        is True
    )
    assert decision1.version == 1 and decision2.version == 1


def test_next_endpoint_returns_a_claimable_work_item_over_http(client, db) -> None:
    project, publication, reviewer1, _, _ = setup_screening(db)
    create_screening_work_items(db, project, ScreeningStage.TITLE_ABSTRACT)
    db.commit()

    login = client.post(
        "/api/v1/auth/login", json={"username": "reviewer1", "password": "password-1"}
    )
    assert login.status_code == 200
    csrf = login.json()["csrfToken"]

    response = client.post(
        f"/api/v1/projects/{project.id}/screening/title_abstract/next",
        headers={"X-CSRF-Token": csrf},
    )
    assert response.status_code == 200
    body = response.json()
    assert body is not None
    assert body["projectId"] == project.id
    assert body["stage"] == "title_abstract"
    assert body["slotNumber"] in (1, 2)
    assert body["publication"]["title"] == publication.title
    assert {criterion["kind"] for criterion in body["criteria"]} == {
        "inclusion",
        "exclusion",
    }

    empty = client.post(
        f"/api/v1/projects/{project.id}/screening/title_abstract/next",
        headers={"X-CSRF-Token": csrf},
    )
    assert empty.status_code == 200
    assert empty.json() is None


def test_revising_decision_preserves_previous_revision(db) -> None:
    project, _, reviewer1, _, criteria = setup_screening(db)
    create_screening_work_items(db, project, ScreeningStage.TITLE_ABSTRACT)
    db.commit()
    item = claim_next_work_item(
        db, project.id, ScreeningStage.TITLE_ABSTRACT, reviewer1.id
    )
    submit_decision(
        db,
        item,
        reviewer1.id,
        "include",
        {criterion.id: False for criterion in criteria},
        "first",
    )
    revised = submit_decision(
        db,
        item,
        reviewer1.id,
        "uncertain",
        {criterion.id: True for criterion in criteria},
        "revised",
    )
    db.commit()
    decisions = list(
        db.scalars(
            select(ScreeningDecision)
            .where(ScreeningDecision.work_item_id == item.id)
            .order_by(ScreeningDecision.version)
        )
    )
    assert [decision.version for decision in decisions] == [1, 2]
    assert decisions[0].is_current is False
    assert revised.is_current is True


def test_stage_completed_reflects_project_progress(db) -> None:
    project, *_ = setup_screening(db)
    assert stage_completed(project, ScreeningStage.TITLE_ABSTRACT) is False
    project.stage = ProjectStage.FULL_TEXT
    assert stage_completed(project, ScreeningStage.TITLE_ABSTRACT) is True
    assert stage_completed(project, ScreeningStage.FULL_TEXT) is False


def test_my_submitted_work_items_lists_only_own_submitted_decisions(db) -> None:
    project, _, reviewer1, reviewer2, criteria = setup_screening(db)
    create_screening_work_items(db, project, ScreeningStage.TITLE_ABSTRACT)
    db.commit()
    first = claim_next_work_item(
        db, project.id, ScreeningStage.TITLE_ABSTRACT, reviewer1.id
    )
    claim_next_work_item(db, project.id, ScreeningStage.TITLE_ABSTRACT, reviewer2.id)
    db.commit()

    assert my_submitted_work_items(
        db, project.id, ScreeningStage.TITLE_ABSTRACT, reviewer1.id
    ) == []

    submit_decision(
        db, first, reviewer1.id, "include", {c.id: True for c in criteria}, None
    )
    db.commit()

    mine = my_submitted_work_items(
        db, project.id, ScreeningStage.TITLE_ABSTRACT, reviewer1.id
    )
    assert [item.id for item in mine] == [first.id]

    # Not yet submitted by reviewer2, so it shouldn't show up for them either.
    assert my_submitted_work_items(
        db, project.id, ScreeningStage.TITLE_ABSTRACT, reviewer2.id
    ) == []


def test_reviewer_can_revise_decision_via_http_and_gets_flagged_after_completion(
    client, db
) -> None:
    project, _, reviewer1, reviewer2, criteria = setup_screening(db)
    create_screening_work_items(db, project, ScreeningStage.TITLE_ABSTRACT)
    db.commit()
    first = claim_next_work_item(
        db, project.id, ScreeningStage.TITLE_ABSTRACT, reviewer1.id
    )
    second = claim_next_work_item(
        db, project.id, ScreeningStage.TITLE_ABSTRACT, reviewer2.id
    )
    submit_decision(
        db, first, reviewer1.id, "include", {c.id: True for c in criteria}, None
    )
    submit_decision(
        db, second, reviewer2.id, "include", {c.id: True for c in criteria}, None
    )
    db.commit()
    project.stage = ProjectStage.FULL_TEXT
    db.commit()

    login = client.post(
        "/api/v1/auth/login", json={"username": "reviewer1", "password": "password-1"}
    )
    csrf = login.json()["csrfToken"]

    listing = client.get(
        f"/api/v1/projects/{project.id}/screening/title_abstract/my-decisions"
    )
    assert listing.status_code == 200
    body = listing.json()
    assert body["stageCompleted"] is True
    assert len(body["items"]) == 1
    assert body["items"][0]["workItemId"] == first.id
    assert body["items"][0]["decision"]["outcome"] == "include"

    revise = client.post(
        f"/api/v1/projects/{project.id}/screening/work-items/{first.id}/decision",
        headers={"X-CSRF-Token": csrf},
        json={
            "outcome": "exclude",
            "criteriaAnswers": {c.id: False for c in criteria},
            "notes": "changed my mind",
        },
    )
    assert revise.status_code == 200
    revised_body = revise.json()
    assert revised_body["version"] == 2
    assert revised_body["outcome"] == "exclude"
