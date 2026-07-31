from sqlalchemy import select

from app.accounts.service import create_user
from app.conflicts.service import (
    record_final_decision,
    refresh_automatic_final_decision,
    transition_if_screening_complete,
)
from app.forms.models import FormKind
from app.forms.service import create_form
from app.fulltext.models import FullTextRetrieval, RetrievalStatus
from app.fulltext.service import (
    initialize_full_text_stage,
    resolve_retrieval,
    set_retrieval_status,
    transition_if_full_text_complete,
)
from app.projects.models import (
    Project,
    ProjectMembership,
    ProjectStage,
    ReviewType,
    ScreeningConfig,
    ScreeningStage,
)
from app.publications.models import Publication
from app.screening.models import ScreeningWorkItem
from app.screening.service import submit_decision


def setup_fulltext(db, *, with_extraction_form: bool = True):
    admin = create_user(db, "admin", "Admin", "secret-password", is_admin=True)
    reviewer = create_user(db, "reviewer", "Reviewer", "reviewer-password")
    project = Project(
        name="Review",
        review_type=ReviewType.SYSTEMATIC_REVIEW,
        random_seed="seed",
        stage=ProjectStage.FULL_TEXT,
    )
    db.add(project)
    db.flush()
    db.add(
        ProjectMembership(
            project_id=project.id, user_id=reviewer.id, can_full_text_screen=True
        )
    )
    db.add(
        ScreeningConfig(
            project_id=project.id, stage=ScreeningStage.FULL_TEXT, required_reviewers=1
        )
    )
    included = Publication(
        project_id=project.id,
        title="Included",
        authors="Doe, Jane",
        doi="10.1/included",
    )
    excluded = Publication(project_id=project.id, title="Excluded")
    db.add_all([included, excluded])
    db.flush()
    record_final_decision(
        db,
        included.id,
        ScreeningStage.TITLE_ABSTRACT,
        "include",
        "agreement",
        None,
        None,
    )
    record_final_decision(
        db,
        excluded.id,
        ScreeningStage.TITLE_ABSTRACT,
        "exclude",
        "agreement",
        None,
        None,
    )
    if with_extraction_form:
        create_form(db, "Extraction form", FormKind.EXTRACTION, project_id=project.id)
    db.commit()
    return admin, reviewer, project, included, excluded


def test_only_title_abstract_inclusions_receive_retrieval_records(db) -> None:
    _, _, project, included, excluded = setup_fulltext(db)
    assert initialize_full_text_stage(db, project) == 1
    db.commit()
    retrievals = list(
        db.scalars(
            select(FullTextRetrieval).where(FullTextRetrieval.project_id == project.id)
        )
    )
    assert [item.publication_id for item in retrievals] == [included.id]
    assert retrievals[0].status == RetrievalStatus.NOT_YET_SOUGHT


def test_available_full_text_creates_screening_item_and_unavailable_report_completes(
    db,
) -> None:
    _, reviewer, project, included, _ = setup_fulltext(db)
    initialize_full_text_stage(db, project)
    db.commit()
    retrieval = db.scalar(
        select(FullTextRetrieval).where(FullTextRetrieval.publication_id == included.id)
    )

    set_retrieval_status(db, retrieval, RetrievalStatus.AVAILABLE)
    db.commit()
    item = db.scalar(
        select(ScreeningWorkItem).where(
            ScreeningWorkItem.publication_id == included.id,
            ScreeningWorkItem.stage == ScreeningStage.FULL_TEXT,
        )
    )
    assert item is not None
    assert item.assigned_reviewer_id == reviewer.id
    assert transition_if_full_text_complete(db, project) is False

    set_retrieval_status(db, retrieval, RetrievalStatus.NOT_FOUND)
    assert transition_if_full_text_complete(db, project) is True
    assert project.stage == ProjectStage.EXTRACTION


def test_transition_blocked_without_extraction_form(db) -> None:
    _, _, project, included, _ = setup_fulltext(db, with_extraction_form=False)
    initialize_full_text_stage(db, project)
    db.commit()
    retrieval = db.scalar(
        select(FullTextRetrieval).where(FullTextRetrieval.publication_id == included.id)
    )

    set_retrieval_status(db, retrieval, RetrievalStatus.NOT_FOUND)
    assert transition_if_full_text_complete(db, project) is False
    assert project.stage == ProjectStage.FULL_TEXT

    create_form(db, "Extraction form", FormKind.EXTRACTION, project_id=project.id)
    assert transition_if_full_text_complete(db, project) is True
    assert project.stage == ProjectStage.EXTRACTION


def test_submitting_the_last_full_text_decision_transitions_to_extraction(db) -> None:
    # Title/abstract-excluded publications never get a full-text decision, so
    # this exercises the same stage-completion path the /decision endpoint
    # uses (transition_if_screening_complete), not just the fulltext-specific
    # helper — regression check for the excluded publication being wrongly
    # counted as "unresolved" for the full-text stage.
    _, reviewer, project, included, _excluded = setup_fulltext(db)
    initialize_full_text_stage(db, project)
    db.commit()
    retrieval = db.scalar(
        select(FullTextRetrieval).where(FullTextRetrieval.publication_id == included.id)
    )
    set_retrieval_status(db, retrieval, RetrievalStatus.AVAILABLE)
    db.commit()
    item = db.scalar(
        select(ScreeningWorkItem).where(
            ScreeningWorkItem.publication_id == included.id,
            ScreeningWorkItem.stage == ScreeningStage.FULL_TEXT,
        )
    )

    submit_decision(db, item, reviewer.id, "include", {}, None)
    refresh_automatic_final_decision(db, included.id, ScreeningStage.FULL_TEXT)
    db.commit()

    assert (
        transition_if_screening_complete(db, project, ScreeningStage.FULL_TEXT) is True
    )
    assert project.stage == ProjectStage.EXTRACTION


def test_resolve_retrieval_marks_available_and_submits_decision_in_one_call(
    db,
) -> None:
    _, reviewer, project, included, _ = setup_fulltext(db)
    initialize_full_text_stage(db, project)
    db.commit()
    retrieval = db.scalar(
        select(FullTextRetrieval).where(FullTextRetrieval.publication_id == included.id)
    )

    decision = resolve_retrieval(
        db,
        retrieval,
        RetrievalStatus.AVAILABLE,
        note=None,
        user_id=reviewer.id,
        decision_outcome="include",
        decision_criteria_answers={},
        decision_notes=None,
    )
    db.commit()

    assert decision is not None
    assert retrieval.status == RetrievalStatus.AVAILABLE
    item = db.scalar(
        select(ScreeningWorkItem).where(
            ScreeningWorkItem.publication_id == included.id,
            ScreeningWorkItem.stage == ScreeningStage.FULL_TEXT,
        )
    )
    assert item.status.value == "submitted"
    assert transition_if_full_text_complete(db, project) is True


def test_resolve_retrieval_without_decision_only_saves_status(db) -> None:
    _, reviewer, project, included, _ = setup_fulltext(db)
    initialize_full_text_stage(db, project)
    db.commit()
    retrieval = db.scalar(
        select(FullTextRetrieval).where(FullTextRetrieval.publication_id == included.id)
    )

    decision = resolve_retrieval(
        db,
        retrieval,
        RetrievalStatus.REQUESTED,
        note="Requested via ILL",
        user_id=reviewer.id,
    )
    db.commit()

    assert decision is None
    assert retrieval.status == RetrievalStatus.REQUESTED
    assert retrieval.note == "Requested via ILL"


def test_update_retrieval_endpoint_resolves_status_and_decision_together(
    client, db
) -> None:
    _, reviewer, project, included, _ = setup_fulltext(db)
    initialize_full_text_stage(db, project)
    db.commit()
    retrieval = db.scalar(
        select(FullTextRetrieval).where(FullTextRetrieval.publication_id == included.id)
    )

    csrf = client.post(
        "/api/v1/auth/login",
        json={"username": reviewer.username, "password": "reviewer-password"},
    ).json()["csrfToken"]
    response = client.put(
        f"/api/v1/projects/{project.id}/full-text/{retrieval.id}",
        json={
            "status": "available",
            "note": None,
            "decision": {"outcome": "include", "criteriaAnswers": {}, "notes": None},
        },
        headers={"X-CSRF-Token": csrf},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "available"
    assert body["decisionSubmitted"] is True

    item = db.scalar(
        select(ScreeningWorkItem).where(
            ScreeningWorkItem.publication_id == included.id,
            ScreeningWorkItem.stage == ScreeningStage.FULL_TEXT,
        )
    )
    assert item.status.value == "submitted"


def test_list_retrievals_includes_publication_details(client, db) -> None:
    _, _, project, included, _ = setup_fulltext(db)
    initialize_full_text_stage(db, project)
    db.commit()

    csrf = client.post(
        "/api/v1/auth/login",
        json={"username": "admin", "password": "secret-password"},
    ).json()["csrfToken"]
    response = client.get(
        f"/api/v1/projects/{project.id}/full-text", headers={"X-CSRF-Token": csrf}
    )

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
