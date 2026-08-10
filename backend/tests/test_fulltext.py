from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select

from app.accounts.service import create_user
from app.api.errors import ForbiddenError
from app.conflicts.service import (
    record_final_decision,
    refresh_automatic_final_decision,
    transition_if_screening_complete,
)
from app.forms.models import FormKind
from app.forms.service import create_form
from app.fulltext.models import FullTextRetrieval, RetrievalStatus
from app.fulltext.service import (
    claim_next_retrieval,
    initialize_full_text_stage,
    release_retrieval_claim,
    resolve_retrieval,
    retrieval_progress,
    set_retrieval_status,
    transition_if_full_text_complete,
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
            project_id=project.id,
            stage=ScreeningStage.FULL_TEXT,
            required_reviewers=1,
            allocation_mode=AllocationMode.DIVIDED,
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


def setup_two_reviewer_retrievals(db):
    """Two eligible reviewers and two untouched retrieval records, for
    exercising the claim queue directly without going through title/abstract
    screening."""
    create_user(db, "admin", "Admin", "secret-password", is_admin=True)
    reviewer1 = create_user(db, "reviewer1", "Reviewer One", "secret-password")
    reviewer2 = create_user(db, "reviewer2", "Reviewer Two", "secret-password")
    project = Project(
        name="Review",
        review_type=ReviewType.SYSTEMATIC_REVIEW,
        random_seed="seed",
        stage=ProjectStage.FULL_TEXT,
    )
    db.add(project)
    db.flush()
    for reviewer in (reviewer1, reviewer2):
        db.add(
            ProjectMembership(
                project_id=project.id, user_id=reviewer.id, can_full_text_screen=True
            )
        )
    pub_a = Publication(project_id=project.id, title="Paper A")
    pub_b = Publication(project_id=project.id, title="Paper B")
    db.add_all([pub_a, pub_b])
    db.flush()
    retrieval_a = FullTextRetrieval(project_id=project.id, publication_id=pub_a.id)
    retrieval_b = FullTextRetrieval(project_id=project.id, publication_id=pub_b.id)
    db.add_all([retrieval_a, retrieval_b])
    db.commit()
    return project, reviewer1, reviewer2, pub_a, pub_b


def test_claim_next_retrieval_never_hands_the_same_paper_to_two_reviewers(db) -> None:
    project, reviewer1, reviewer2, pub_a, pub_b = setup_two_reviewer_retrievals(db)

    first = claim_next_retrieval(db, project.id, reviewer1.id)
    second = claim_next_retrieval(db, project.id, reviewer2.id)
    db.commit()

    assert first is not None
    assert second is not None
    assert {first.publication_id, second.publication_id} == {pub_a.id, pub_b.id}
    assert first.claimed_by_id == reviewer1.id
    assert second.claimed_by_id == reviewer2.id
    assert claim_next_retrieval(db, project.id, reviewer2.id).id == second.id


def test_claim_next_retrieval_prefers_untouched_papers_over_my_own_followup(
    db,
) -> None:
    project, reviewer1, _reviewer2, pub_a, pub_b = setup_two_reviewer_retrievals(db)

    claimed = claim_next_retrieval(db, project.id, reviewer1.id)
    assert claimed.publication_id == pub_a.id
    set_retrieval_status(
        db,
        claimed,
        RetrievalStatus.REQUESTED,
        note="ILL requested",
        user_id=reviewer1.id,
    )
    db.commit()

    # Paper B has never been touched, so it's offered before circling back to
    # the reviewer's own outstanding ILL request.
    next_claim = claim_next_retrieval(db, project.id, reviewer1.id)
    assert next_claim.publication_id == pub_b.id


def test_claim_next_retrieval_temporarily_excludes_skipped_items(db) -> None:
    project, reviewer1, _reviewer2, pub_a, pub_b = setup_two_reviewer_retrievals(db)
    retrieval_a = db.scalar(
        select(FullTextRetrieval).where(FullTextRetrieval.publication_id == pub_a.id)
    )

    claimed = claim_next_retrieval(db, project.id, reviewer1.id, {retrieval_a.id})

    assert claimed is not None
    assert claimed.publication_id == pub_b.id


def test_my_full_text_decisions_include_inaccessible_retrieval_outcomes(
    client, db
) -> None:
    _admin, reviewer, project, included, _excluded = setup_fulltext(db)
    initialize_full_text_stage(db, project)
    retrieval = db.scalar(
        select(FullTextRetrieval).where(FullTextRetrieval.publication_id == included.id)
    )
    set_retrieval_status(
        db,
        retrieval,
        RetrievalStatus.INACCESSIBLE,
        note="Institutional access unavailable",
        user_id=reviewer.id,
    )
    db.commit()
    login = client.post(
        "/api/v1/auth/login",
        json={"username": "reviewer", "password": "reviewer-password"},
    )
    assert login.status_code == 200

    response = client.get(
        f"/api/v1/projects/{project.id}/screening/full_text/my-decisions"
    )

    assert response.status_code == 200
    items = response.json()["items"]
    assert len(items) == 1
    assert items[0]["workItemId"] == retrieval.id
    assert items[0]["submittedAt"] is not None
    assert items[0]["publication"]["id"] == included.id
    assert items[0]["publication"]["title"] == "Included"
    assert items[0]["decision"] is None
    assert items[0]["retrievalStatus"] == "inaccessible"
    assert items[0]["retrievalNote"] == "Institutional access unavailable"


def test_claim_next_retrieval_lets_another_reviewer_take_over_an_expired_claim(
    db,
) -> None:
    project, reviewer1, reviewer2, pub_a, _pub_b = setup_two_reviewer_retrievals(db)
    retrieval = db.scalar(
        select(FullTextRetrieval).where(FullTextRetrieval.publication_id == pub_a.id)
    )
    retrieval.claimed_by_id = reviewer1.id
    retrieval.claimed_until = datetime.now(UTC) - timedelta(hours=1)
    db.commit()

    reclaimed = claim_next_retrieval(db, project.id, reviewer2.id)
    assert reclaimed.publication_id == pub_a.id
    assert reclaimed.claimed_by_id == reviewer2.id


def test_release_retrieval_claim_frees_it_for_another_reviewer(db) -> None:
    project, reviewer1, reviewer2, pub_a, pub_b = setup_two_reviewer_retrievals(db)
    claimed = claim_next_retrieval(db, project.id, reviewer1.id)
    db.commit()

    release_retrieval_claim(claimed, reviewer1.id)
    db.commit()

    reclaimed_ids = {
        claim_next_retrieval(db, project.id, reviewer2.id).publication_id
        for _ in range(1)
    }
    assert claimed.publication_id in reclaimed_ids


def test_release_retrieval_claim_requires_the_current_claimant(db) -> None:
    project, reviewer1, reviewer2, _pub_a, _pub_b = setup_two_reviewer_retrievals(db)
    claimed = claim_next_retrieval(db, project.id, reviewer1.id)
    db.commit()

    with pytest.raises(ForbiddenError):
        release_retrieval_claim(claimed, reviewer2.id)


def test_resolve_retrieval_rejects_an_update_from_a_reviewer_without_the_claim(
    db,
) -> None:
    project, reviewer1, reviewer2, pub_a, _pub_b = setup_two_reviewer_retrievals(db)
    claimed = claim_next_retrieval(db, project.id, reviewer1.id)
    db.commit()

    with pytest.raises(ForbiddenError):
        resolve_retrieval(db, claimed, RetrievalStatus.NOT_FOUND, user_id=reviewer2.id)


def test_retrieval_progress_counts_addressed_and_total(db) -> None:
    project, reviewer1, _reviewer2, pub_a, _pub_b = setup_two_reviewer_retrievals(db)
    claimed = claim_next_retrieval(db, project.id, reviewer1.id)
    db.commit()
    assert retrieval_progress(db, project.id) == {"total": 2, "addressed": 0}

    resolve_retrieval(db, claimed, RetrievalStatus.NOT_FOUND, user_id=reviewer1.id)
    db.commit()
    assert retrieval_progress(db, project.id) == {"total": 2, "addressed": 1}


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


def test_full_text_completion_check_does_not_rewind_a_later_stage(db) -> None:
    _, _, project, _, _ = setup_fulltext(db)
    project.stage = ProjectStage.EXTRACTION

    assert transition_if_full_text_complete(db, project) is False
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


def test_full_text_next_progress_and_release_routes(client, db) -> None:
    _, reviewer, project, included, _ = setup_fulltext(db)
    initialize_full_text_stage(db, project)
    db.commit()

    csrf = client.post(
        "/api/v1/auth/login",
        json={"username": reviewer.username, "password": "reviewer-password"},
    ).json()["csrfToken"]

    claimed = client.post(
        f"/api/v1/projects/{project.id}/full-text/next", headers={"X-CSRF-Token": csrf}
    )
    assert claimed.status_code == 200
    body = claimed.json()
    assert body is not None
    assert body["publicationId"] == included.id

    progress = client.get(
        f"/api/v1/projects/{project.id}/full-text/progress",
        headers={"X-CSRF-Token": csrf},
    )
    assert progress.status_code == 200
    assert progress.json() == {"total": 1, "addressed": 0}

    # Nothing left to claim while the reviewer holds the only retrieval.
    empty = client.post(
        f"/api/v1/projects/{project.id}/full-text/next", headers={"X-CSRF-Token": csrf}
    )
    assert empty.json() is not None
    assert empty.json()["id"] == body["id"]

    released = client.post(
        f"/api/v1/projects/{project.id}/full-text/{body['id']}/release",
        headers={"X-CSRF-Token": csrf},
    )
    assert released.status_code == 200
    assert released.json() == {"status": "released"}


def test_full_text_next_and_update_require_the_full_text_reviewer_capability(
    client, db
) -> None:
    _, _, project, included, _ = setup_fulltext(db)
    initialize_full_text_stage(db, project)
    extractor = create_user(db, "extractor", "Extractor", "extractor-password")
    db.add(
        ProjectMembership(project_id=project.id, user_id=extractor.id, can_extract=True)
    )
    db.commit()
    retrieval = db.scalar(
        select(FullTextRetrieval).where(FullTextRetrieval.publication_id == included.id)
    )

    csrf = client.post(
        "/api/v1/auth/login",
        json={"username": "extractor", "password": "extractor-password"},
    ).json()["csrfToken"]

    claim_attempt = client.post(
        f"/api/v1/projects/{project.id}/full-text/next", headers={"X-CSRF-Token": csrf}
    )
    assert claim_attempt.status_code == 403

    update_attempt = client.put(
        f"/api/v1/projects/{project.id}/full-text/{retrieval.id}",
        json={"status": "not_found", "note": None, "decision": None},
        headers={"X-CSRF-Token": csrf},
    )
    assert update_attempt.status_code == 403
