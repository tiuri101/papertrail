from sqlalchemy import select

from app.accounts.service import create_user
from app.deduplication.models import DuplicateCandidate
from app.deduplication.service import (
    detect_duplicates,
    mark_not_duplicate,
    merge_publications,
    reverse_merge,
    transition_if_duplicate_review_complete,
)
from app.imports.models import ImportBatch, ImportedRecord, ImportStatus
from app.jobs.models import BackgroundJob, JobStatus
from app.projects.models import Project, ProjectMembership, ProjectStage, ReviewType
from app.publications.models import MetadataConflict, Publication, PublicationSource


def login(client) -> str:
    response = client.post(
        "/api/v1/auth/login", json={"username": "admin", "password": "secret-password"}
    )
    return response.json()["csrfToken"]


def complete_draft_setup(client, csrf: str, project_id: str, db) -> None:
    client.post(
        f"/api/v1/projects/{project_id}/research-questions",
        json={"text": "How is X studied?"},
        headers={"X-CSRF-Token": csrf},
    )
    client.post(
        f"/api/v1/projects/{project_id}/criteria",
        json={"text": "Uses X", "kind": "inclusion"},
        headers={"X-CSRF-Token": csrf},
    )
    client.post(
        f"/api/v1/projects/{project_id}/criteria",
        json={"text": "Not peer reviewed", "kind": "exclusion"},
        headers={"X-CSRF-Token": csrf},
    )
    client.post(
        f"/api/v1/projects/{project_id}/publications",
        json={"title": "A paper"},
        headers={"X-CSRF-Token": csrf},
    )
    reviewer = create_user(db, "reviewer", "Reviewer", "secret-password")
    db.commit()
    client.post(
        f"/api/v1/projects/{project_id}/members",
        json={"userId": reviewer.id, "canTitleAbstractScreen": True},
        headers={"X-CSRF-Token": csrf},
    )


def test_marking_a_draft_project_ready_queues_duplicate_detection(client, db) -> None:
    create_user(db, "admin", "Administrator", "secret-password", is_admin=True)
    db.commit()
    csrf = login(client)
    project_id = client.post(
        "/api/v1/projects",
        json={"name": "Review", "reviewType": "systematic_review"},
        headers={"X-CSRF-Token": csrf},
    ).json()["id"]
    complete_draft_setup(client, csrf, project_id, db)

    ready = client.post(
        f"/api/v1/projects/{project_id}/ready", headers={"X-CSRF-Token": csrf}
    )
    assert ready.status_code == 202
    assert ready.json()["stage"] == "duplicate_review"

    project = client.get(f"/api/v1/projects/{project_id}")
    assert project.json()["stage"] == "duplicate_review"

    again = client.post(
        f"/api/v1/projects/{project_id}/ready", headers={"X-CSRF-Token": csrf}
    )
    assert again.status_code == 400


def test_marking_an_incomplete_draft_project_ready_is_rejected(client, db) -> None:
    create_user(db, "admin", "Administrator", "secret-password", is_admin=True)
    db.commit()
    csrf = login(client)
    project_id = client.post(
        "/api/v1/projects",
        json={"name": "Review", "reviewType": "systematic_review"},
        headers={"X-CSRF-Token": csrf},
    ).json()["id"]

    ready = client.post(
        f"/api/v1/projects/{project_id}/ready", headers={"X-CSRF-Token": csrf}
    )
    assert ready.status_code == 400

    project = client.get(f"/api/v1/projects/{project_id}")
    assert project.json()["stage"] == "draft"


def test_project_owner_can_rerun_duplicate_detection(client, db) -> None:
    owner = create_user(db, "admin", "Project Owner", "secret-password")
    project = Project(
        name="Review",
        review_type=ReviewType.SYSTEMATIC_REVIEW,
        random_seed="seed",
        stage=ProjectStage.DUPLICATE_REVIEW,
    )
    db.add(project)
    db.flush()
    db.add(ProjectMembership(project_id=project.id, user_id=owner.id, is_owner=True))
    db.commit()
    csrf = login(client)

    response = client.post(
        f"/api/v1/projects/{project.id}/duplicates/detect",
        headers={"X-CSRF-Token": csrf},
    )

    assert response.status_code == 202
    job = db.scalar(
        select(BackgroundJob).where(
            BackgroundJob.project_id == project.id,
            BackgroundJob.job_type == "detect_duplicates",
        )
    )
    assert job is not None
    assert job.status == JobStatus.QUEUED
    assert response.json() == {"jobId": job.id, "status": "queued"}

    duplicate_click = client.post(
        f"/api/v1/projects/{project.id}/duplicates/detect",
        headers={"X-CSRF-Token": csrf},
    )
    assert duplicate_click.status_code == 409


def test_list_candidates_includes_publication_details(client, db) -> None:
    create_user(db, "admin", "Administrator", "secret-password", is_admin=True)
    project = Project(
        name="Review",
        review_type=ReviewType.SYSTEMATIC_REVIEW,
        random_seed="seed",
        stage=ProjectStage.DUPLICATE_REVIEW,
    )
    db.add(project)
    db.flush()
    pub_a = Publication(
        project_id=project.id,
        title="A Study of Urban VR",
        authors="Doe, Jane",
        publication_year=2025,
        venue="CHI",
        doi="10.1000/same",
    )
    pub_b = Publication(
        project_id=project.id,
        title="A study of urban VR",
        authors="Doe, J.",
        publication_year=2025,
        venue="CHI Extended Abstracts",
        doi="10.1000/same",
    )
    db.add_all([pub_a, pub_b])
    db.commit()

    detect_duplicates(db, project.id)
    db.commit()

    csrf = login(client)
    response = client.get(
        f"/api/v1/projects/{project.id}/duplicates", headers={"X-CSRF-Token": csrf}
    )
    assert response.status_code == 200
    candidates = response.json()
    assert len(candidates) == 1
    candidate = candidates[0]
    titles = {candidate["publicationA"]["title"], candidate["publicationB"]["title"]}
    assert titles == {"A Study of Urban VR", "A study of urban VR"}
    assert candidate["publicationA"]["doi"] == "10.1000/same"
    assert candidate["publicationA"]["venue"] in {"CHI", "CHI Extended Abstracts"}


def test_a_regular_project_member_can_resolve_duplicates(client, db) -> None:
    create_user(db, "admin", "Administrator", "secret-password", is_admin=True)
    project = Project(
        name="Review",
        review_type=ReviewType.SYSTEMATIC_REVIEW,
        random_seed="seed",
        stage=ProjectStage.DUPLICATE_REVIEW,
    )
    db.add(project)
    db.flush()
    pub_a = Publication(
        project_id=project.id, title="A Study of Urban VR", doi="10.1000/same"
    )
    pub_b = Publication(
        project_id=project.id, title="A study of urban VR", doi="10.1000/same"
    )
    db.add_all([pub_a, pub_b])
    db.commit()

    detect_duplicates(db, project.id)
    db.commit()

    member = create_user(db, "reviewer", "Reviewer", "secret-password")
    db.commit()
    admin_csrf = login(client)
    added = client.post(
        f"/api/v1/projects/{project.id}/members",
        json={"userId": member.id},
        headers={"X-CSRF-Token": admin_csrf},
    )
    assert added.status_code == 201

    member_csrf = client.post(
        "/api/v1/auth/login",
        json={"username": "reviewer", "password": "secret-password"},
    ).json()["csrfToken"]

    listed = client.get(
        f"/api/v1/projects/{project.id}/duplicates",
        headers={"X-CSRF-Token": member_csrf},
    )
    assert listed.status_code == 200
    candidate_id = listed.json()[0]["id"]

    resolved = client.post(
        f"/api/v1/projects/{project.id}/duplicates/{candidate_id}/not-duplicate",
        json={"note": None},
        headers={"X-CSRF-Token": member_csrf},
    )
    assert resolved.status_code == 200
    assert resolved.json()["status"] == "not_duplicate"


def setup_records(db):
    admin = create_user(db, "admin", "Admin", "secret-password", is_admin=True)
    project = Project(
        name="Review",
        review_type=ReviewType.SYSTEMATIC_REVIEW,
        random_seed="seed",
        stage=ProjectStage.DUPLICATE_REVIEW,
    )
    db.add(project)
    db.flush()
    batch = ImportBatch(
        project_id=project.id,
        original_filename="x.csv",
        stored_path="/tmp/x",
        file_type="csv",
        status=ImportStatus.COMPLETED,
        created_by_id=admin.id,
    )
    db.add(batch)
    db.flush()
    imported = []
    publications = []
    for index, title in enumerate(["A Study of Urban VR", "A study of urban VR"]):
        record = ImportedRecord(
            import_batch_id=batch.id,
            source_row=index + 2,
            raw_data={},
            parsed_data={"title": title},
            validation_state="valid",
            warnings=[],
        )
        publication = Publication(
            project_id=project.id,
            title=title,
            doi="10.1000/same" if index == 0 else "10.1000/same",
        )
        db.add_all([record, publication])
        db.flush()
        db.add(
            PublicationSource(
                publication_id=publication.id, imported_record_id=record.id
            )
        )
        imported.append(record)
        publications.append(publication)
    db.commit()
    return project, publications


def test_detect_merge_and_reverse_duplicate(db) -> None:
    project, publications = setup_records(db)
    count = detect_duplicates(db, project.id)
    db.commit()
    assert count == 1
    candidate = db.scalar(
        select(DuplicateCandidate).where(DuplicateCandidate.project_id == project.id)
    )
    assert candidate is not None
    assert "exact_doi" in candidate.match_reasons

    merge = merge_publications(db, candidate, publications[0].id)
    db.commit()
    assert publications[1].is_active is False
    assert publications[1].merged_into_id == publications[0].id
    assert len(publications[0].sources) == 2
    assert merge.reversed_at is None

    reverse_merge(db, merge)
    db.commit()
    assert publications[1].is_active is True
    assert publications[1].merged_into_id is None
    assert len(publications[0].sources) == 1
    assert merge.reversed_at is not None


def test_detect_duplicates_matches_similar_title_with_year_agreement(db) -> None:
    project = Project(
        name="Review",
        review_type=ReviewType.SYSTEMATIC_REVIEW,
        random_seed="seed",
        stage=ProjectStage.DUPLICATE_REVIEW,
    )
    db.add(project)
    db.flush()
    pub_a = Publication(
        project_id=project.id,
        title="Systematic review of mobile health interventions for diabetes",
        publication_year=2022,
    )
    pub_b = Publication(
        project_id=project.id,
        title="A systematic review on mobile health apps for diabetes care",
        publication_year=2022,
    )
    db.add_all([pub_a, pub_b])
    db.commit()

    assert detect_duplicates(db, project.id) == 1
    candidate = db.scalar(
        select(DuplicateCandidate).where(DuplicateCandidate.project_id == project.id)
    )
    assert candidate is not None
    assert "similar_title_year" in candidate.match_reasons
    assert candidate.year_agreement is True


def test_detect_duplicates_matches_unique_publication_identifiers(db) -> None:
    project = Project(
        name="Review",
        review_type=ReviewType.SYSTEMATIC_REVIEW,
        random_seed="seed",
        stage=ProjectStage.DUPLICATE_REVIEW,
    )
    db.add(project)
    db.flush()
    pub_a = Publication(
        project_id=project.id,
        title="Completely different title one",
        pubmed_id="PMID12345",
    )
    pub_b = Publication(
        project_id=project.id,
        title="Completely different title two",
        pubmed_id="PMID12345",
    )
    db.add_all([pub_a, pub_b])
    db.commit()

    assert detect_duplicates(db, project.id) == 1
    candidate = db.scalar(
        select(DuplicateCandidate).where(DuplicateCandidate.project_id == project.id)
    )
    assert candidate is not None
    assert "exact_pubmed_id" in candidate.match_reasons
    assert candidate.confidence == 1.0


def test_detect_duplicates_does_not_treat_shared_isbn_or_issn_as_proof(db) -> None:
    project = Project(
        name="Review",
        review_type=ReviewType.SYSTEMATIC_REVIEW,
        random_seed="seed",
        stage=ProjectStage.DUPLICATE_REVIEW,
    )
    db.add(project)
    db.flush()
    pub_a = Publication(
        project_id=project.id,
        title="Immersive analytics for energy systems",
        authors="Doe, Jane",
        doi="10.1000/energy",
        isbn="978-1-2345-6789-0",
        issn="1234-5678",
    )
    pub_b = Publication(
        project_id=project.id,
        title="A taxonomy of collaborative visualization",
        authors="Smith, John",
        doi="10.1000/collaboration",
        isbn="978-1-2345-6789-0",
        issn="1234-5678",
    )
    db.add_all([pub_a, pub_b])
    db.commit()

    assert detect_duplicates(db, project.id) == 0
    assert (
        db.scalar(
            select(DuplicateCandidate).where(
                DuplicateCandidate.project_id == project.id
            )
        )
        is None
    )


def test_detect_duplicates_refreshes_stale_unresolved_candidates(db) -> None:
    project = Project(
        name="Review",
        review_type=ReviewType.SYSTEMATIC_REVIEW,
        random_seed="seed",
        stage=ProjectStage.DUPLICATE_REVIEW,
    )
    db.add(project)
    db.flush()
    pub_a = Publication(
        project_id=project.id,
        title="A Study of Urban VR",
        doi="10.1000/same",
    )
    pub_b = Publication(
        project_id=project.id,
        title="A Study of Urban VR",
        doi="10.1000/same",
    )
    db.add_all([pub_a, pub_b])
    db.commit()

    assert detect_duplicates(db, project.id) == 1
    candidate = db.scalar(
        select(DuplicateCandidate).where(DuplicateCandidate.project_id == project.id)
    )
    assert candidate is not None
    assert candidate.confidence == 1.0

    pub_b.doi = "10.1000/different"
    assert detect_duplicates(db, project.id) == 0
    assert candidate.match_reasons == ["exact_title"]
    assert candidate.confidence == 0.99

    pub_b.title = "A completely unrelated publication"
    assert detect_duplicates(db, project.id) == 0
    assert (
        db.scalar(
            select(DuplicateCandidate).where(
                DuplicateCandidate.project_id == project.id
            )
        )
        is None
    )


def test_merge_flags_conflicting_important_fields_instead_of_dropping_them(db) -> None:
    project = Project(
        name="Review",
        review_type=ReviewType.SYSTEMATIC_REVIEW,
        random_seed="seed",
        stage=ProjectStage.DUPLICATE_REVIEW,
    )
    db.add(project)
    db.flush()
    canonical = Publication(
        project_id=project.id,
        title="A Study of Urban VR",
        authors="Doe, Jane",
        doi="10.1000/same",
        publisher_url=None,
    )
    duplicate = Publication(
        project_id=project.id,
        title="A Study of Urban VR (preprint)",
        authors="Doe, Jane",
        doi="10.1000/same",
        publisher_url="https://example.com/duplicate",
    )
    db.add_all([canonical, duplicate])
    db.commit()
    candidate = DuplicateCandidate(
        project_id=project.id,
        publication_a_id=canonical.id,
        publication_b_id=duplicate.id,
        match_reasons=["exact_doi"],
        confidence=1.0,
    )
    db.add(candidate)
    db.commit()

    merge_publications(db, candidate, canonical.id)
    db.commit()

    # A non-important field that's empty on canonical is still filled from
    # the duplicate (existing "prefer most complete metadata" behavior).
    assert canonical.publisher_url == "https://example.com/duplicate"
    # The conflicting important field (title) must NOT be silently
    # overwritten — it should surface as a conflict for manual resolution.
    assert canonical.title == "A Study of Urban VR"
    conflict = db.scalar(
        select(MetadataConflict).where(
            MetadataConflict.publication_id == canonical.id,
            MetadataConflict.field_name == "title",
        )
    )
    assert conflict is not None
    assert conflict.source_name == "merge"
    assert conflict.current_value == "A Study of Urban VR"
    assert conflict.proposed_value == "A Study of Urban VR (preprint)"
    assert conflict.status == "open"


def test_reversing_a_merge_clears_the_conflicts_it_created(db) -> None:
    project = Project(
        name="Review",
        review_type=ReviewType.SYSTEMATIC_REVIEW,
        random_seed="seed",
        stage=ProjectStage.DUPLICATE_REVIEW,
    )
    db.add(project)
    db.flush()
    canonical = Publication(
        project_id=project.id,
        title="Canonical title",
        doi="10.1000/same",
    )
    duplicate = Publication(
        project_id=project.id,
        title="Different title",
        doi="10.1000/same",
    )
    db.add_all([canonical, duplicate])
    db.commit()
    candidate = DuplicateCandidate(
        project_id=project.id,
        publication_a_id=canonical.id,
        publication_b_id=duplicate.id,
        match_reasons=["exact_doi"],
        confidence=1.0,
    )
    db.add(candidate)
    db.commit()

    merge = merge_publications(db, candidate, canonical.id)
    db.commit()
    assert (
        db.scalar(
            select(MetadataConflict).where(
                MetadataConflict.publication_id == canonical.id,
                MetadataConflict.status == "open",
            )
        )
        is not None
    )

    reverse_merge(db, merge)
    db.commit()
    assert (
        db.scalar(
            select(MetadataConflict).where(
                MetadataConflict.publication_id == canonical.id,
                MetadataConflict.status == "open",
            )
        )
        is None
    )


def test_duplicate_review_only_transitions_when_all_candidates_resolved(db) -> None:
    project, _ = setup_records(db)
    detect_duplicates(db, project.id)
    db.commit()
    assert transition_if_duplicate_review_complete(db, project) is False
    candidate = db.scalar(
        select(DuplicateCandidate).where(DuplicateCandidate.project_id == project.id)
    )
    mark_not_duplicate(candidate)
    assert transition_if_duplicate_review_complete(db, project) is True
    assert project.stage == ProjectStage.TITLE_ABSTRACT
