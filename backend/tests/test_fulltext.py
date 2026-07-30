from sqlalchemy import select

from app.accounts.service import create_user
from app.conflicts.service import record_final_decision
from app.fulltext.models import FullTextRetrieval, RetrievalStatus
from app.fulltext.service import initialize_full_text_stage, set_retrieval_status, transition_if_full_text_complete
from app.projects.models import Project, ProjectMembership, ProjectStage, ReviewType, ScreeningConfig, ScreeningStage
from app.publications.models import Publication
from app.screening.models import ScreeningWorkItem


def setup_fulltext(db):
    admin = create_user(db, "admin", "Admin", "secret-password", is_admin=True)
    reviewer = create_user(db, "reviewer", "Reviewer", "reviewer-password")
    project = Project(name="Review", review_type=ReviewType.SYSTEMATIC_REVIEW, random_seed="seed", stage=ProjectStage.FULL_TEXT)
    db.add(project); db.flush()
    db.add(ProjectMembership(project_id=project.id, user_id=reviewer.id, can_full_text_screen=True))
    db.add(ScreeningConfig(project_id=project.id, stage=ScreeningStage.FULL_TEXT, required_reviewers=1))
    included = Publication(project_id=project.id, title="Included", authors="Doe, Jane", doi="10.1/included")
    excluded = Publication(project_id=project.id, title="Excluded")
    db.add_all([included, excluded]); db.flush()
    record_final_decision(db, included.id, ScreeningStage.TITLE_ABSTRACT, "include", "agreement", None, None)
    record_final_decision(db, excluded.id, ScreeningStage.TITLE_ABSTRACT, "exclude", "agreement", None, None)
    db.commit()
    return admin, reviewer, project, included, excluded


def test_only_title_abstract_inclusions_receive_retrieval_records(db) -> None:
    _, _, project, included, excluded = setup_fulltext(db)
    assert initialize_full_text_stage(db, project) == 1
    db.commit()
    retrievals = list(db.scalars(select(FullTextRetrieval).where(FullTextRetrieval.project_id == project.id)))
    assert [item.publication_id for item in retrievals] == [included.id]
    assert retrievals[0].status == RetrievalStatus.NOT_YET_SOUGHT


def test_available_full_text_creates_screening_item_and_unavailable_report_completes(db) -> None:
    _, reviewer, project, included, _ = setup_fulltext(db)
    initialize_full_text_stage(db, project)
    db.commit()
    retrieval = db.scalar(select(FullTextRetrieval).where(FullTextRetrieval.publication_id == included.id))

    set_retrieval_status(db, retrieval, RetrievalStatus.AVAILABLE)
    db.commit()
    item = db.scalar(select(ScreeningWorkItem).where(ScreeningWorkItem.publication_id == included.id, ScreeningWorkItem.stage == ScreeningStage.FULL_TEXT))
    assert item is not None
    assert item.assigned_reviewer_id == reviewer.id
    assert transition_if_full_text_complete(db, project) is False

    set_retrieval_status(db, retrieval, RetrievalStatus.NOT_FOUND)
    assert transition_if_full_text_complete(db, project) is True
    assert project.stage == ProjectStage.EXTRACTION


def test_list_retrievals_includes_publication_details(client, db) -> None:
    _, _, project, included, _ = setup_fulltext(db)
    initialize_full_text_stage(db, project)
    db.commit()

    csrf = client.post(
        "/api/v1/auth/login", json={"username": "admin", "password": "secret-password"},
    ).json()["csrfToken"]
    response = client.get(f"/api/v1/projects/{project.id}/full-text", headers={"X-CSRF-Token": csrf})

    assert response.status_code == 200
    [retrieval] = response.json()
    assert retrieval["publication"] == {
        "id": included.id,
        "title": "Included",
        "authors": "Doe, Jane",
        "publicationYear": None,
        "doi": "10.1/included",
        "publisherUrl": None,
    }
