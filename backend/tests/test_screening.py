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
from app.screening.models import ScreeningDecision, ScreeningWorkItem, WorkItemStatus
from app.screening.service import (
    claim_next_work_item,
    create_screening_work_items,
    decisions_visible,
    my_submitted_work_items,
    reassign_work_items_from_ineligible_reviewers,
    rebalance_pending_work_items,
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
    resumed = claim_next_work_item(
        db, project.id, ScreeningStage.TITLE_ABSTRACT, reviewer1.id
    )
    assert resumed is not None
    assert resumed.id == first.id

    second = claim_next_work_item(
        db, project.id, ScreeningStage.TITLE_ABSTRACT, reviewer2.id
    )
    assert second is not None
    assert second.publication_id == publication.id
    assert second.id != first.id


def test_claim_next_work_item_prefers_publication_with_completed_llm_suggestion(
    db, monkeypatch
) -> None:
    from datetime import UTC as _UTC
    from datetime import datetime as _datetime

    from app.core.config import get_settings
    from app.llm.models import LlmExtractionRun, LlmTaskType, ProcessingStatus
    from app.llm.task_service import project_settings

    settings = get_settings()
    monkeypatch.setattr(settings, "llm_enabled", True)
    monkeypatch.setattr(settings, "ollama_model", "test-model:latest")

    reviewer = create_user(db, "reviewer1", "Reviewer 1", "password-1")
    project = Project(
        name="Review",
        review_type=ReviewType.SYSTEMATIC_REVIEW,
        random_seed="global-seed",
        stage=ProjectStage.TITLE_ABSTRACT,
    )
    db.add(project)
    db.flush()
    db.add(
        ProjectMembership(
            project_id=project.id,
            user_id=reviewer.id,
            can_title_abstract_screen=True,
        )
    )
    db.add(
        ScreeningConfig(
            project_id=project.id,
            stage=ScreeningStage.TITLE_ABSTRACT,
            required_reviewers=1,
            allocation_mode=AllocationMode.INDEPENDENT,
        )
    )
    db.add(
        Criterion(
            project_id=project.id,
            kind=CriterionKind.INCLUSION,
            text="Relevant topic",
            position=0,
        )
    )
    pub_ready = Publication(project_id=project.id, title="Ready paper", abstract="A")
    pub_pending = Publication(
        project_id=project.id, title="Pending paper", abstract="B"
    )
    db.add_all([pub_ready, pub_pending])
    db.commit()

    llm_settings = project_settings(db, project.id, create=True)
    llm_settings.title_abstract_screening_enabled = True
    db.commit()

    assert create_screening_work_items(db, project, ScreeningStage.TITLE_ABSTRACT) == 2
    db.commit()
    items = {
        item.publication_id: item for item in db.scalars(select(ScreeningWorkItem))
    }
    # Force the LLM-ready publication's rank to sort *after* the pending one, so
    # the assertion below can only pass because of LLM-readiness, not luck.
    items[pub_ready.id].random_rank = "f" * 64
    items[pub_pending.id].random_rank = "0" * 64
    db.add(
        LlmExtractionRun(
            project_id=project.id,
            publication_id=pub_ready.id,
            task_type=LlmTaskType.TITLE_ABSTRACT_SCREENING,
            input_fingerprint="fp",
            provider="ollama",
            model="test-model:latest",
            model_configuration={},
            prompt_template_version="v1",
            status=ProcessingStatus.COMPLETED,
            queued_at=_datetime.now(_UTC),
        )
    )
    db.commit()

    claimed = claim_next_work_item(
        db, project.id, ScreeningStage.TITLE_ABSTRACT, reviewer.id
    )
    assert claimed is not None
    assert claimed.publication_id == pub_ready.id


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


def setup_three_publications_two_reviewers(db):
    """Regression setup for the reported bug: 3 publications, required_reviewers=1,
    2 initially-eligible reviewers so round-robin assignment splits 2/1 between
    them -- then one reviewer is removed, and their single assigned publication
    should not end up permanently stuck."""
    admin = create_user(db, "admin", "Administrator", "secret-password", is_admin=True)
    reviewer1 = create_user(db, "reviewer1", "Reviewer 1", "password-1")
    reviewer2 = create_user(db, "reviewer2", "Reviewer 2", "password-2")
    project = Project(
        name="Test",
        review_type=ReviewType.SYSTEMATIC_REVIEW,
        random_seed="seed",
        stage=ProjectStage.TITLE_ABSTRACT,
    )
    db.add(project)
    db.flush()
    membership1 = ProjectMembership(
        project_id=project.id, user_id=reviewer1.id, can_title_abstract_screen=True
    )
    membership2 = ProjectMembership(
        project_id=project.id, user_id=reviewer2.id, can_title_abstract_screen=True
    )
    db.add_all([membership1, membership2])
    db.add(
        ScreeningConfig(
            project_id=project.id,
            stage=ScreeningStage.TITLE_ABSTRACT,
            required_reviewers=1,
            allocation_mode=AllocationMode.INDEPENDENT,
        )
    )
    publications = [
        Publication(project_id=project.id, title=f"Paper {i}") for i in range(3)
    ]
    db.add_all(publications)
    db.commit()
    create_screening_work_items(db, project, ScreeningStage.TITLE_ABSTRACT)
    db.commit()
    return admin, project, publications, reviewer1, reviewer2, membership2


def assignees(db, project_id) -> set[str | None]:
    return {
        item.assigned_reviewer_id
        for item in db.scalars(
            select(ScreeningWorkItem).where(ScreeningWorkItem.project_id == project_id)
        )
    }


def test_removing_a_reviewer_reassigns_their_pending_work_items(client, db) -> None:
    (
        _,
        project,
        publications,
        reviewer1,
        reviewer2,
        membership2,
    ) = setup_three_publications_two_reviewers(db)
    assert assignees(db, project.id) == {reviewer1.id, reviewer2.id}

    login = client.post(
        "/api/v1/auth/login", json={"username": "admin", "password": "secret-password"}
    )
    csrf = login.json()["csrfToken"]
    response = client.delete(
        f"/api/v1/projects/{project.id}/members/{membership2.id}",
        headers={"X-CSRF-Token": csrf},
    )
    assert response.status_code == 204

    assert assignees(db, project.id) == {reviewer1.id}

    reviewer_login = client.post(
        "/api/v1/auth/login", json={"username": "reviewer1", "password": "password-1"}
    )
    reviewer_csrf = reviewer_login.json()["csrfToken"]
    claimed_titles = set()
    for _ in range(3):
        response = client.post(
            f"/api/v1/projects/{project.id}/screening/title_abstract/next",
            headers={"X-CSRF-Token": reviewer_csrf},
        )
        body = response.json()
        assert body is not None
        claimed_titles.add(body["publication"]["title"])
        decision = client.post(
            f"/api/v1/projects/{project.id}/screening/work-items/{body['id']}/decision",
            headers={"X-CSRF-Token": reviewer_csrf},
            json={
                "outcome": "include",
                "criteriaAnswers": {},
                "notes": None,
            },
        )
        assert decision.status_code == 200
    assert claimed_titles == {publication.title for publication in publications}


def test_revoking_a_reviewers_stage_permission_reassigns_their_work_items(
    client, db
) -> None:
    (
        _,
        project,
        _,
        reviewer1,
        reviewer2,
        membership2,
    ) = setup_three_publications_two_reviewers(db)

    login = client.post(
        "/api/v1/auth/login", json={"username": "admin", "password": "secret-password"}
    )
    csrf = login.json()["csrfToken"]
    response = client.patch(
        f"/api/v1/projects/{project.id}/members/{membership2.id}",
        json={"canTitleAbstractScreen": False},
        headers={"X-CSRF-Token": csrf},
    )
    assert response.status_code == 200

    assert assignees(db, project.id) == {reviewer1.id}


def test_next_endpoint_self_heals_a_work_item_left_on_an_ineligible_reviewer(
    client, db
) -> None:
    """Covers projects that were already broken before this fix existed: the
    orphaned assignment predates the membership-change hook, so the /next
    endpoint's own defensive reassignment has to catch it instead."""
    (
        _,
        project,
        publications,
        reviewer1,
        reviewer2,
        membership2,
    ) = setup_three_publications_two_reviewers(db)
    db.delete(membership2)
    db.commit()
    assert reviewer2.id in assignees(db, project.id)

    login = client.post(
        "/api/v1/auth/login", json={"username": "reviewer1", "password": "password-1"}
    )
    csrf = login.json()["csrfToken"]
    claimed_titles = set()
    for _ in range(3):
        response = client.post(
            f"/api/v1/projects/{project.id}/screening/title_abstract/next",
            headers={"X-CSRF-Token": csrf},
        )
        body = response.json()
        assert body is not None
        claimed_titles.add(body["publication"]["title"])
        decision = client.post(
            f"/api/v1/projects/{project.id}/screening/work-items/{body['id']}/decision",
            headers={"X-CSRF-Token": csrf},
            json={
                "outcome": "include",
                "criteriaAnswers": {},
                "notes": None,
            },
        )
        assert decision.status_code == 200
    assert claimed_titles == {publication.title for publication in publications}
    assert assignees(db, project.id) == {reviewer1.id}


def test_submitted_work_items_are_not_reassigned(db) -> None:
    (
        _,
        project,
        publications,
        reviewer1,
        reviewer2,
        membership2,
    ) = setup_three_publications_two_reviewers(db)
    reviewer2_item = next(
        item
        for item in db.scalars(
            select(ScreeningWorkItem).where(
                ScreeningWorkItem.project_id == project.id,
                ScreeningWorkItem.assigned_reviewer_id == reviewer2.id,
            )
        )
    )
    submit_decision(db, reviewer2_item, reviewer2.id, "include", {}, None)
    db.commit()

    db.delete(membership2)
    db.commit()

    reassigned = reassign_work_items_from_ineligible_reviewers(
        db, project.id, ScreeningStage.TITLE_ABSTRACT
    )
    db.commit()

    assert reassigned == 0
    still_assigned = db.get(ScreeningWorkItem, reviewer2_item.id)
    assert still_assigned.assigned_reviewer_id == reviewer2.id
    assert still_assigned.status == WorkItemStatus.SUBMITTED


def test_rebalance_spreads_backlog_onto_a_newly_added_reviewer(db) -> None:
    (
        _,
        project,
        publications,
        reviewer1,
        reviewer2,
        _,
    ) = setup_three_publications_two_reviewers(db)

    def counts() -> dict[str, int]:
        tally: dict[str, int] = {}
        for item in db.scalars(
            select(ScreeningWorkItem).where(ScreeningWorkItem.project_id == project.id)
        ):
            tally[item.assigned_reviewer_id] = (
                tally.get(item.assigned_reviewer_id, 0) + 1
            )
        return tally

    before = counts()
    assert before == {reviewer1.id: 2, reviewer2.id: 1}

    reviewer3 = create_user(db, "reviewer3", "Reviewer 3", "password-3")
    db.add(
        ProjectMembership(
            project_id=project.id, user_id=reviewer3.id, can_title_abstract_screen=True
        )
    )
    db.commit()

    reassigned = rebalance_pending_work_items(
        db, project.id, ScreeningStage.TITLE_ABSTRACT
    )
    db.commit()

    assert reassigned > 0
    after = counts()
    assert after == {reviewer1.id: 1, reviewer2.id: 1, reviewer3.id: 1}


def test_rebalance_never_gives_a_reviewer_two_slots_of_the_same_publication(db) -> None:
    create_user(db, "admin", "Administrator", "secret-password", is_admin=True)
    reviewer1 = create_user(db, "reviewer1", "Reviewer 1", "password-1")
    reviewer2 = create_user(db, "reviewer2", "Reviewer 2", "password-2")
    project = Project(
        name="Test",
        review_type=ReviewType.SYSTEMATIC_REVIEW,
        random_seed="seed",
        stage=ProjectStage.TITLE_ABSTRACT,
    )
    db.add(project)
    db.flush()
    db.add_all(
        [
            ProjectMembership(
                project_id=project.id,
                user_id=reviewer1.id,
                can_title_abstract_screen=True,
            ),
            ProjectMembership(
                project_id=project.id,
                user_id=reviewer2.id,
                can_title_abstract_screen=True,
            ),
        ]
    )
    db.add(
        ScreeningConfig(
            project_id=project.id,
            stage=ScreeningStage.TITLE_ABSTRACT,
            required_reviewers=2,
            allocation_mode=AllocationMode.INDEPENDENT,
        )
    )
    publication = Publication(project_id=project.id, title="Paper 0")
    db.add(publication)
    db.commit()
    create_screening_work_items(db, project, ScreeningStage.TITLE_ABSTRACT)
    db.commit()

    slot1, slot2 = list(
        db.scalars(
            select(ScreeningWorkItem)
            .where(ScreeningWorkItem.project_id == project.id)
            .order_by(ScreeningWorkItem.slot_number)
        )
    )
    submit_decision(db, slot1, slot1.assigned_reviewer_id, "include", {}, None)
    db.commit()

    rebalance_pending_work_items(db, project.id, ScreeningStage.TITLE_ABSTRACT)
    db.commit()

    db.refresh(slot2)
    assert slot2.assigned_reviewer_id != slot1.assigned_reviewer_id


def test_admin_can_manually_reassign_a_work_item_to_a_project_member(
    client, db
) -> None:
    _, project, _, reviewer1, reviewer2, _ = setup_three_publications_two_reviewers(db)
    item = db.scalar(
        select(ScreeningWorkItem).where(
            ScreeningWorkItem.project_id == project.id,
            ScreeningWorkItem.assigned_reviewer_id == reviewer1.id,
        )
    )

    login = client.post(
        "/api/v1/auth/login", json={"username": "admin", "password": "secret-password"}
    )
    csrf = login.json()["csrfToken"]
    response = client.patch(
        f"/api/v1/projects/{project.id}/screening/work-items/{item.id}/reassign",
        json={"reviewerId": reviewer2.id},
        headers={"X-CSRF-Token": csrf},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["assignedReviewerId"] == reviewer2.id
    assert body["assignedReviewerName"] == "Reviewer 2"
    assert body["status"] == "available"

    db.refresh(item)
    assert item.assigned_reviewer_id == reviewer2.id
    assert item.status == WorkItemStatus.AVAILABLE


def test_reassignment_rejects_a_reviewer_who_is_not_a_project_member(
    client, db
) -> None:
    _, project, _, reviewer1, _, _ = setup_three_publications_two_reviewers(db)
    outsider = create_user(db, "outsider", "Outsider", "outsider-password")
    db.commit()
    item = db.scalar(
        select(ScreeningWorkItem).where(
            ScreeningWorkItem.project_id == project.id,
            ScreeningWorkItem.assigned_reviewer_id == reviewer1.id,
        )
    )

    login = client.post(
        "/api/v1/auth/login", json={"username": "admin", "password": "secret-password"}
    )
    csrf = login.json()["csrfToken"]
    response = client.patch(
        f"/api/v1/projects/{project.id}/screening/work-items/{item.id}/reassign",
        json={"reviewerId": outsider.id},
        headers={"X-CSRF-Token": csrf},
    )

    assert response.status_code == 400
    db.refresh(item)
    assert item.assigned_reviewer_id == reviewer1.id


def test_reassignment_rejects_an_already_submitted_work_item(client, db) -> None:
    _, project, _, reviewer1, reviewer2, _ = setup_three_publications_two_reviewers(db)
    item = db.scalar(
        select(ScreeningWorkItem).where(
            ScreeningWorkItem.project_id == project.id,
            ScreeningWorkItem.assigned_reviewer_id == reviewer1.id,
        )
    )
    submit_decision(db, item, reviewer1.id, "include", {}, None)
    db.commit()

    login = client.post(
        "/api/v1/auth/login", json={"username": "admin", "password": "secret-password"}
    )
    csrf = login.json()["csrfToken"]
    response = client.patch(
        f"/api/v1/projects/{project.id}/screening/work-items/{item.id}/reassign",
        json={"reviewerId": reviewer2.id},
        headers={"X-CSRF-Token": csrf},
    )

    assert response.status_code == 400
    db.refresh(item)
    assert item.assigned_reviewer_id == reviewer1.id


def test_non_admin_cannot_reassign_work_items(client, db) -> None:
    _, project, _, reviewer1, reviewer2, _ = setup_three_publications_two_reviewers(db)
    item = db.scalar(
        select(ScreeningWorkItem).where(
            ScreeningWorkItem.project_id == project.id,
            ScreeningWorkItem.assigned_reviewer_id == reviewer1.id,
        )
    )

    login = client.post(
        "/api/v1/auth/login", json={"username": "reviewer1", "password": "password-1"}
    )
    csrf = login.json()["csrfToken"]
    response = client.patch(
        f"/api/v1/projects/{project.id}/screening/work-items/{item.id}/reassign",
        json={"reviewerId": reviewer2.id},
        headers={"X-CSRF-Token": csrf},
    )

    assert response.status_code == 403


def test_list_assignments_returns_publication_and_reviewer_details(client, db) -> None:
    _, project, _, reviewer1, reviewer2, _ = setup_three_publications_two_reviewers(db)

    login = client.post(
        "/api/v1/auth/login", json={"username": "admin", "password": "secret-password"}
    )
    csrf = login.json()["csrfToken"]
    response = client.get(
        f"/api/v1/projects/{project.id}/screening/title_abstract/assignments",
        headers={"X-CSRF-Token": csrf},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["total"] == 3
    assert body["reassignableTotal"] == 3
    assert body["page"] == 1
    assert body["pageSize"] == 20
    titles = {row["publicationTitle"] for row in body["items"]}
    assert titles == {"Paper 0", "Paper 1", "Paper 2"}
    reviewer_names = {row["assignedReviewerName"] for row in body["items"]}
    assert reviewer_names == {"Reviewer 1", "Reviewer 2"}


def test_assignments_pagination_sorting_and_filtering(client, db) -> None:
    _, project, _, reviewer1, reviewer2, _ = setup_three_publications_two_reviewers(db)

    login = client.post(
        "/api/v1/auth/login", json={"username": "admin", "password": "secret-password"}
    )
    csrf = login.json()["csrfToken"]

    first_page = client.get(
        f"/api/v1/projects/{project.id}/screening/title_abstract/assignments"
        "?sort=publicationTitle&order=asc&page=1&pageSize=2",
        headers={"X-CSRF-Token": csrf},
    ).json()
    assert first_page["total"] == 3
    assert [row["publicationTitle"] for row in first_page["items"]] == [
        "Paper 0",
        "Paper 1",
    ]

    second_page = client.get(
        f"/api/v1/projects/{project.id}/screening/title_abstract/assignments"
        "?sort=publicationTitle&order=asc&page=2&pageSize=2",
        headers={"X-CSRF-Token": csrf},
    ).json()
    assert [row["publicationTitle"] for row in second_page["items"]] == ["Paper 2"]

    descending = client.get(
        f"/api/v1/projects/{project.id}/screening/title_abstract/assignments"
        "?sort=publicationTitle&order=desc",
        headers={"X-CSRF-Token": csrf},
    ).json()
    assert [row["publicationTitle"] for row in descending["items"]] == [
        "Paper 2",
        "Paper 1",
        "Paper 0",
    ]

    searched = client.get(
        f"/api/v1/projects/{project.id}/screening/title_abstract/assignments"
        "?search=Paper 1",
        headers={"X-CSRF-Token": csrf},
    ).json()
    assert [row["publicationTitle"] for row in searched["items"]] == ["Paper 1"]
    assert searched["total"] == 1

    reviewer2_publication_id = db.scalar(
        select(ScreeningWorkItem.publication_id).where(
            ScreeningWorkItem.project_id == project.id,
            ScreeningWorkItem.assigned_reviewer_id == reviewer2.id,
        )
    )
    reviewer2_title = db.scalar(
        select(Publication.title).where(Publication.id == reviewer2_publication_id)
    )
    by_reviewer = client.get(
        f"/api/v1/projects/{project.id}/screening/title_abstract/assignments"
        f"?reviewerId={reviewer2.id}",
        headers={"X-CSRF-Token": csrf},
    ).json()
    assert {row["publicationTitle"] for row in by_reviewer["items"]} == {
        reviewer2_title
    }
    assert by_reviewer["total"] == 1

    by_status = client.get(
        f"/api/v1/projects/{project.id}/screening/title_abstract/assignments"
        "?status=available",
        headers={"X-CSRF-Token": csrf},
    ).json()
    assert by_status["total"] == 3


def test_bulk_reassignment_selects_all_filtered_assignments_across_pages(
    client, db
) -> None:
    _, project, _, reviewer1, reviewer2, _ = setup_three_publications_two_reviewers(db)
    excluded = db.scalar(
        select(ScreeningWorkItem).where(
            ScreeningWorkItem.project_id == project.id,
            ScreeningWorkItem.assigned_reviewer_id == reviewer1.id,
        )
    )
    assert excluded is not None

    login = client.post(
        "/api/v1/auth/login", json={"username": "admin", "password": "secret-password"}
    )
    csrf = login.json()["csrfToken"]
    first_page = client.get(
        f"/api/v1/projects/{project.id}/screening/title_abstract/assignments"
        "?search=Paper&page=1&pageSize=1",
        headers={"X-CSRF-Token": csrf},
    ).json()
    assert len(first_page["items"]) == 1
    assert first_page["reassignableTotal"] == 3

    response = client.patch(
        f"/api/v1/projects/{project.id}/screening/title_abstract/assignments/reassign",
        json={
            "reviewerId": reviewer2.id,
            "selectAllFiltered": True,
            "excludedWorkItemIds": [excluded.id],
            "search": "Paper",
        },
        headers={"X-CSRF-Token": csrf},
    )

    assert response.status_code == 200
    assert response.json() == {"reassigned": 2}
    db.refresh(excluded)
    assert excluded.assigned_reviewer_id == reviewer1.id
    included = list(
        db.scalars(
            select(ScreeningWorkItem).where(
                ScreeningWorkItem.project_id == project.id,
                ScreeningWorkItem.id != excluded.id,
            )
        )
    )
    assert {item.assigned_reviewer_id for item in included} == {reviewer2.id}


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

    resumed = client.post(
        f"/api/v1/projects/{project.id}/screening/title_abstract/next",
        headers={"X-CSRF-Token": csrf},
    )
    assert resumed.status_code == 200
    assert resumed.json()["id"] == body["id"]


def test_next_endpoint_backfills_a_publication_left_without_a_work_item(
    client, db
) -> None:
    """Regression test: a publication that ended up with no screening work item
    (e.g. added after title/abstract screening had already started, before the
    creation-time fix existed) must still surface to the reviewer, not sit
    permanently invisible in their queue."""
    project, publication, reviewer1, reviewer2, criteria = setup_screening(db)
    create_screening_work_items(
        db, project, ScreeningStage.TITLE_ABSTRACT, publication_ids=[publication.id]
    )
    orphaned = Publication(project_id=project.id, title="Orphaned paper")
    db.add(orphaned)
    db.commit()
    assert (
        db.scalar(
            select(ScreeningWorkItem).where(
                ScreeningWorkItem.publication_id == orphaned.id
            )
        )
        is None
    )

    login = client.post(
        "/api/v1/auth/login", json={"username": "reviewer1", "password": "password-1"}
    )
    csrf = login.json()["csrfToken"]

    first_response = client.post(
        f"/api/v1/projects/{project.id}/screening/title_abstract/next",
        headers={"X-CSRF-Token": csrf},
    )
    assert first_response.status_code == 200
    first = first_response.json()
    assert first is not None

    decision = client.post(
        f"/api/v1/projects/{project.id}/screening/work-items/{first['id']}/decision",
        headers={"X-CSRF-Token": csrf},
        json={
            "outcome": "include",
            "criteriaAnswers": {
                criteria[0].id: True,
                criteria[1].id: False,
            },
            "notes": None,
        },
    )
    assert decision.status_code == 200

    second_response = client.post(
        f"/api/v1/projects/{project.id}/screening/title_abstract/next",
        headers={"X-CSRF-Token": csrf},
    )
    assert second_response.status_code == 200
    second = second_response.json()
    assert second is not None

    assert {first["publication"]["title"], second["publication"]["title"]} == {
        publication.title,
        "Orphaned paper",
    }


def test_get_work_item_returns_the_reviewers_own_decision(client, db) -> None:
    project, publication, reviewer1, reviewer2, criteria = setup_screening(db)
    create_screening_work_items(db, project, ScreeningStage.TITLE_ABSTRACT)
    db.commit()

    login = client.post(
        "/api/v1/auth/login", json={"username": "reviewer1", "password": "password-1"}
    )
    csrf = login.json()["csrfToken"]

    claimed = client.post(
        f"/api/v1/projects/{project.id}/screening/title_abstract/next",
        headers={"X-CSRF-Token": csrf},
    ).json()

    decision = client.post(
        f"/api/v1/projects/{project.id}/screening/work-items/{claimed['id']}/decision",
        headers={"X-CSRF-Token": csrf},
        json={
            "outcome": "include",
            "criteriaAnswers": {criteria[0].id: True, criteria[1].id: False},
            "notes": "looks relevant",
        },
    )
    assert decision.status_code == 200

    fetched = client.get(
        f"/api/v1/projects/{project.id}/screening/work-items/{claimed['id']}"
    )
    assert fetched.status_code == 200
    body = fetched.json()
    assert body["id"] == claimed["id"]
    assert body["publication"]["title"] == publication.title
    assert body["decision"]["outcome"] == "include"
    assert body["decision"]["notes"] == "looks relevant"
    assert body["decision"]["criteriaAnswers"] == {
        criteria[0].id: True,
        criteria[1].id: False,
    }

    other_login = client.post(
        "/api/v1/auth/login", json={"username": "reviewer2", "password": "password-2"}
    )
    assert other_login.status_code == 200
    forbidden = client.get(
        f"/api/v1/projects/{project.id}/screening/work-items/{claimed['id']}"
    )
    assert forbidden.status_code == 403


def test_progress_endpoint_reports_assigned_and_completed_counts(client, db) -> None:
    project, publication, reviewer1, _, criteria = setup_screening(db)
    second = Publication(project_id=project.id, title="Second paper")
    db.add(second)
    db.commit()
    create_screening_work_items(db, project, ScreeningStage.TITLE_ABSTRACT)
    db.commit()

    login = client.post(
        "/api/v1/auth/login", json={"username": "reviewer1", "password": "password-1"}
    )
    csrf = login.json()["csrfToken"]

    before = client.get(
        f"/api/v1/projects/{project.id}/screening/title_abstract/progress",
        headers={"X-CSRF-Token": csrf},
    )
    assert before.status_code == 200
    assert before.json() == {
        "assigned": 2,
        "completed": 0,
        "remaining": 0,
        "claimMode": False,
    }

    item = claim_next_work_item(
        db, project.id, ScreeningStage.TITLE_ABSTRACT, reviewer1.id
    )
    submit_decision(
        db,
        item,
        reviewer1.id,
        "include",
        {criteria[0].id: True, criteria[1].id: False},
        None,
    )
    db.commit()

    after = client.get(
        f"/api/v1/projects/{project.id}/screening/title_abstract/progress",
        headers={"X-CSRF-Token": csrf},
    )
    assert after.status_code == 200
    assert after.json() == {
        "assigned": 2,
        "completed": 1,
        "remaining": 0,
        "claimMode": False,
    }


def test_progress_endpoint_reports_remaining_in_claim_mode(client, db) -> None:
    project, _, reviewer1, _, criteria = setup_screening(db)
    config = db.scalar(
        select(ScreeningConfig).where(
            ScreeningConfig.project_id == project.id,
            ScreeningConfig.stage == ScreeningStage.TITLE_ABSTRACT,
        )
    )
    config.allocation_mode = AllocationMode.CLAIM
    db.commit()
    create_screening_work_items(db, project, ScreeningStage.TITLE_ABSTRACT)
    db.commit()

    login = client.post(
        "/api/v1/auth/login", json={"username": "reviewer1", "password": "password-1"}
    )
    csrf = login.json()["csrfToken"]

    before = client.get(
        f"/api/v1/projects/{project.id}/screening/title_abstract/progress",
        headers={"X-CSRF-Token": csrf},
    )
    assert before.status_code == 200
    assert before.json() == {
        "assigned": 0,
        "completed": 0,
        "remaining": 1,
        "claimMode": True,
    }

    item = claim_next_work_item(
        db, project.id, ScreeningStage.TITLE_ABSTRACT, reviewer1.id
    )
    submit_decision(
        db,
        item,
        reviewer1.id,
        "include",
        {criteria[0].id: True, criteria[1].id: False},
        None,
    )
    db.commit()

    after = client.get(
        f"/api/v1/projects/{project.id}/screening/title_abstract/progress",
        headers={"X-CSRF-Token": csrf},
    )
    assert after.status_code == 200
    assert after.json() == {
        "assigned": 1,
        "completed": 1,
        "remaining": 0,
        "claimMode": True,
    }


def test_releasing_claimed_item_returns_it_to_the_open_pool(client, db) -> None:
    """Releasing a claimed item (e.g. navigating away mid-screening) must clear
    assigned_reviewer_id in claim mode, or the item becomes an orphan: still
    counted in this reviewer's `remaining`, but never offered to anyone again
    since claim_next_work_item only offers unassigned items."""
    project, _, reviewer1, reviewer2, _ = setup_screening(db)
    config = db.scalar(
        select(ScreeningConfig).where(
            ScreeningConfig.project_id == project.id,
            ScreeningConfig.stage == ScreeningStage.TITLE_ABSTRACT,
        )
    )
    config.allocation_mode = AllocationMode.CLAIM
    db.commit()
    create_screening_work_items(db, project, ScreeningStage.TITLE_ABSTRACT)
    db.commit()

    login = client.post(
        "/api/v1/auth/login", json={"username": "reviewer1", "password": "password-1"}
    )
    csrf = login.json()["csrfToken"]

    item = claim_next_work_item(
        db, project.id, ScreeningStage.TITLE_ABSTRACT, reviewer1.id
    )
    db.commit()
    assert item is not None
    assert item.assigned_reviewer_id == reviewer1.id

    released = client.post(
        f"/api/v1/projects/{project.id}/screening/work-items/{item.id}/release",
        headers={"X-CSRF-Token": csrf},
    )
    assert released.status_code == 200
    db.refresh(item)
    assert item.status == WorkItemStatus.AVAILABLE
    assert item.assigned_reviewer_id is None

    progress = client.get(
        f"/api/v1/projects/{project.id}/screening/title_abstract/progress",
        headers={"X-CSRF-Token": csrf},
    )
    assert progress.json()["remaining"] == 1

    reclaimed = claim_next_work_item(
        db, project.id, ScreeningStage.TITLE_ABSTRACT, reviewer2.id
    )
    assert reclaimed is not None
    assert reclaimed.id == item.id


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

    assert (
        my_submitted_work_items(
            db, project.id, ScreeningStage.TITLE_ABSTRACT, reviewer1.id
        )
        == []
    )

    submit_decision(
        db, first, reviewer1.id, "include", {c.id: True for c in criteria}, None
    )
    db.commit()

    mine = my_submitted_work_items(
        db, project.id, ScreeningStage.TITLE_ABSTRACT, reviewer1.id
    )
    assert [item.id for item in mine] == [first.id]

    # Not yet submitted by reviewer2, so it shouldn't show up for them either.
    assert (
        my_submitted_work_items(
            db, project.id, ScreeningStage.TITLE_ABSTRACT, reviewer2.id
        )
        == []
    )


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
    assert revised_body["projectStage"] == ProjectStage.FULL_TEXT
    assert revised_body["stageUnchanged"] is True
    assert revised_body["pendingWorkflowSteps"] == [
        "Resolve the revised title/abstract screening decision"
    ]
    db.refresh(project)
    assert project.stage == ProjectStage.FULL_TEXT
