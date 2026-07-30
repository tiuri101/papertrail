
from app.accounts.service import create_user
from app.conflicts.service import (
    record_final_decision,
    refresh_automatic_final_decision,
    transition_if_screening_complete,
)
from app.projects.models import (
    AllocationMode,
    Criterion,
    CriterionKind,
    ExclusionReason,
    Project,
    ProjectMembership,
    ProjectStage,
    ReviewType,
    ScreeningConfig,
    ScreeningStage,
)
from app.publications.models import Publication
from app.screening.service import (
    claim_next_work_item,
    create_screening_work_items,
    submit_decision,
)


def setup_conflict(db, second_outcome: str = "exclude"):
    admin = create_user(db, "admin", "Admin", "secret-password", is_admin=True)
    r1 = create_user(db, "r1", "R1", "password-1")
    r2 = create_user(db, "r2", "R2", "password-2")
    project = Project(
        name="Review",
        review_type=ReviewType.SYSTEMATIC_REVIEW,
        random_seed="seed",
        stage=ProjectStage.TITLE_ABSTRACT,
    )
    db.add(project)
    db.flush()
    for reviewer in (r1, r2):
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
            required_reviewers=2,
            allocation_mode=AllocationMode.INDEPENDENT,
        )
    )
    criterion = Criterion(
        project_id=project.id, kind=CriterionKind.INCLUSION, text="Relevant", position=0
    )
    publication = Publication(project_id=project.id, title="Paper")
    reason = ExclusionReason(
        project_id=project.id,
        stage=ScreeningStage.TITLE_ABSTRACT,
        label="Wrong topic",
        position=0,
    )
    db.add_all([criterion, publication, reason])
    db.flush()
    create_screening_work_items(db, project, ScreeningStage.TITLE_ABSTRACT)
    db.commit()
    items = []
    for reviewer in (r1, r2):
        item = claim_next_work_item(
            db, project.id, ScreeningStage.TITLE_ABSTRACT, reviewer.id
        )
        items.append(item)
    submit_decision(db, items[0], r1.id, "include", {criterion.id: True}, None, None)
    submit_decision(
        db,
        items[1],
        r2.id,
        second_outcome,
        {criterion.id: True},
        reason.id if second_outcome == "exclude" else None,
        None,
    )
    db.commit()
    return admin, project, publication, r1, r2, items, criterion


def test_conflict_requires_separate_final_consensus(db) -> None:
    admin, project, publication, *_ = setup_conflict(db)
    assert (
        refresh_automatic_final_decision(
            db, publication.id, ScreeningStage.TITLE_ABSTRACT
        )
        is None
    )
    final = record_final_decision(
        db,
        publication.id,
        ScreeningStage.TITLE_ABSTRACT,
        "include",
        "admin_consensus",
        admin.id,
        "Agreed after discussion",
    )
    db.commit()
    assert final.outcome.value == "include"
    assert final.note == "Agreed after discussion"
    assert (
        transition_if_screening_complete(db, project, ScreeningStage.TITLE_ABSTRACT)
        is True
    )
    assert project.stage == ProjectStage.FULL_TEXT


def test_agreement_creates_automatic_final_decision(db) -> None:
    _, project, publication, *_ = setup_conflict(db, second_outcome="include")
    final = refresh_automatic_final_decision(
        db, publication.id, ScreeningStage.TITLE_ABSTRACT
    )
    db.commit()
    assert final is not None
    assert final.resolution_method == "agreement"
    assert (
        transition_if_screening_complete(db, project, ScreeningStage.TITLE_ABSTRACT)
        is True
    )


def test_revision_invalidates_existing_consensus(db) -> None:
    admin, _, publication, r1, _, items, criterion = setup_conflict(db)
    final = record_final_decision(
        db,
        publication.id,
        ScreeningStage.TITLE_ABSTRACT,
        "include",
        "admin_consensus",
        admin.id,
        None,
    )
    db.commit()
    submit_decision(
        db, items[0], r1.id, "uncertain", {criterion.id: True}, None, "changed"
    )
    db.commit()
    db.refresh(final)
    assert final.is_valid is False
    assert final.invalidated_at is not None


def test_list_conflicts_includes_publication_and_reviewer_decisions(client, db) -> None:
    _, project, publication, *_ = setup_conflict(db)

    csrf = client.post(
        "/api/v1/auth/login",
        json={"username": "admin", "password": "secret-password"},
    ).json()["csrfToken"]
    response = client.get(
        f"/api/v1/projects/{project.id}/screening/title_abstract/conflicts",
        headers={"X-CSRF-Token": csrf},
    )

    assert response.status_code == 200
    [conflict] = response.json()
    assert conflict["publicationId"] == publication.id
    assert conflict["publication"]["title"] == "Paper"

    decisions_by_reviewer = {
        decision["reviewer"]["displayName"]: decision
        for decision in conflict["decisions"]
    }
    assert decisions_by_reviewer["R1"]["outcome"] == "include"
    assert decisions_by_reviewer["R1"]["exclusionReasonText"] is None
    assert decisions_by_reviewer["R2"]["outcome"] == "exclude"
    assert decisions_by_reviewer["R2"]["exclusionReasonText"] == "Wrong topic"


def test_list_conflicts_excludes_publications_still_awaiting_decisions(
    client, db
) -> None:
    create_user(db, "admin3", "Admin3", "secret-password", is_admin=True)
    r1 = create_user(db, "r1c", "R1c", "password-1")
    project = Project(
        name="Untouched",
        review_type=ReviewType.SYSTEMATIC_REVIEW,
        random_seed="seed3",
        stage=ProjectStage.TITLE_ABSTRACT,
    )
    db.add(project)
    db.flush()
    db.add(
        ProjectMembership(
            project_id=project.id, user_id=r1.id, can_title_abstract_screen=True
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
    criterion = Criterion(
        project_id=project.id, kind=CriterionKind.INCLUSION, text="Relevant", position=0
    )
    publication = Publication(project_id=project.id, title="Untouched Paper")
    db.add_all([criterion, publication])
    db.flush()
    create_screening_work_items(db, project, ScreeningStage.TITLE_ABSTRACT)
    db.commit()

    # A reviewer opens the record (reserving it) but never submits a decision.
    claim_next_work_item(db, project.id, ScreeningStage.TITLE_ABSTRACT, r1.id)
    db.commit()

    csrf = client.post(
        "/api/v1/auth/login",
        json={"username": "admin3", "password": "secret-password"},
    ).json()["csrfToken"]
    response = client.get(
        f"/api/v1/projects/{project.id}/screening/title_abstract/conflicts",
        headers={"X-CSRF-Token": csrf},
    )

    assert response.status_code == 200
    assert response.json() == []
