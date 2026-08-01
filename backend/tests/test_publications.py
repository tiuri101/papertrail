import datetime

from sqlalchemy import select

from app.accounts.service import create_user
from app.imports.models import ImportBatch, ImportedRecord, ImportStatus, SearchSource
from app.projects.models import (
    AllocationMode,
    Project,
    ProjectMembership,
    ProjectStage,
    ReviewType,
    ScreeningConfig,
    ScreeningStage,
)
from app.publications.models import MetadataConflict, Publication, PublicationSource
from app.publications.service import apply_enrichment, normalize_imported_records
from app.screening.models import ScreeningWorkItem


def login(client) -> str:
    response = client.post(
        "/api/v1/auth/login", json={"username": "admin", "password": "secret-password"}
    )
    return response.json()["csrfToken"]


def test_delete_publication_soft_deletes_and_hides_it_from_the_list(client, db) -> None:
    create_user(db, "admin", "Administrator", "secret-password", is_admin=True)
    project = Project(
        name="Review", review_type=ReviewType.SYSTEMATIC_REVIEW, random_seed="seed"
    )
    db.add(project)
    db.commit()
    csrf = login(client)

    created = client.post(
        f"/api/v1/projects/{project.id}/publications",
        json={"title": "Paper to remove"},
        headers={"X-CSRF-Token": csrf},
    )
    assert created.status_code == 201
    publication_id = created.json()["id"]

    deleted = client.delete(
        f"/api/v1/projects/{project.id}/publications/{publication_id}",
        headers={"X-CSRF-Token": csrf},
    )
    assert deleted.status_code == 204

    listing = client.get(f"/api/v1/projects/{project.id}/publications")
    assert listing.json() == []
    assert (
        client.get(
            f"/api/v1/projects/{project.id}/publications/{publication_id}"
        ).status_code
        == 200
    )

    again = client.delete(
        f"/api/v1/projects/{project.id}/publications/{publication_id}",
        headers={"X-CSRF-Token": csrf},
    )
    assert again.status_code == 404


def test_a_regular_project_member_can_add_a_publication_manually(client, db) -> None:
    create_user(db, "admin", "Administrator", "secret-password", is_admin=True)
    member = create_user(db, "reviewer", "Reviewer", "secret-password")
    project = Project(
        name="Review", review_type=ReviewType.SYSTEMATIC_REVIEW, random_seed="seed"
    )
    db.add(project)
    db.flush()
    db.add(ProjectMembership(project_id=project.id, user_id=member.id))
    db.commit()

    csrf = client.post(
        "/api/v1/auth/login",
        json={"username": "reviewer", "password": "secret-password"},
    ).json()["csrfToken"]

    response = client.post(
        f"/api/v1/projects/{project.id}/publications",
        json={"title": "Added by a reviewer"},
        headers={"X-CSRF-Token": csrf},
    )

    assert response.status_code == 201
    assert response.json()["title"] == "Added by a reviewer"


def project_and_batch(db):
    admin = create_user(db, "admin", "Administrator", "secret-password", is_admin=True)
    project = Project(
        name="Review", review_type=ReviewType.SYSTEMATIC_REVIEW, random_seed="seed"
    )
    db.add_all([project])
    db.flush()
    batch = ImportBatch(
        project_id=project.id,
        original_filename="records.csv",
        stored_path="/tmp/records.csv",
        file_type="csv",
        status=ImportStatus.COMPLETED,
        created_by_id=admin.id,
    )
    db.add(batch)
    db.flush()
    return admin, project, batch


def test_normalization_creates_publication_and_preserves_source(db) -> None:
    _, project, batch = project_and_batch(db)
    record = ImportedRecord(
        import_batch_id=batch.id,
        source_row=2,
        raw_data={"DOI": "https://doi.org/10.1000/ABC"},
        parsed_data={
            "title": "  A  Paper ",
            "authors": "Doe, Jane",
            "doi": "https://doi.org/10.1000/ABC",
            "year": "2026",
        },
        validation_state="valid",
        warnings=[],
    )
    db.add(record)
    db.commit()

    created = normalize_imported_records(db, batch.id)
    db.commit()

    assert created == 1
    publication = db.scalar(
        select(Publication).where(Publication.project_id == project.id)
    )
    assert publication is not None
    assert publication.title == "A Paper"
    assert publication.doi == "10.1000/abc"
    assert publication.publication_year == 2026
    source = db.scalar(
        select(PublicationSource).where(
            PublicationSource.publication_id == publication.id
        )
    )
    assert source.imported_record_id == record.id


def test_publication_search_sources_trace_back_to_the_import(db) -> None:
    admin, project, batch = project_and_batch(db)
    search = SearchSource(
        project_id=project.id,
        source_name="PubMed",
        query="systematic review",
        search_date=datetime.date(2026, 1, 1),
        created_by_id=admin.id,
    )
    db.add(search)
    db.flush()
    batch.search_source_id = search.id
    record = ImportedRecord(
        import_batch_id=batch.id,
        source_row=1,
        raw_data={"title": "Traceable paper"},
        parsed_data={"title": "Traceable paper"},
        validation_state="valid",
        warnings=[],
    )
    db.add(record)
    db.commit()

    created = normalize_imported_records(db, batch.id)
    db.commit()
    assert created == 1

    publication = db.scalar(
        select(Publication).where(Publication.title == "Traceable paper")
    )
    assert publication.search_sources == [
        {
            "import_batch_id": batch.id,
            "original_filename": "records.csv",
            "search_source_id": search.id,
            "source_name": "PubMed",
        }
    ]


def test_manually_created_publication_has_no_search_sources(db) -> None:
    _, project, _ = project_and_batch(db)
    publication = Publication(project_id=project.id, title="Hand-added paper")
    db.add(publication)
    db.commit()

    assert publication.search_sources == []


def test_enrichment_fills_missing_fields_and_records_important_conflicts(db) -> None:
    _, project, _ = project_and_batch(db)
    publication = Publication(
        project_id=project.id, title="Paper", authors="Doe", publication_year=2025
    )
    db.add(publication)
    db.flush()

    conflicts = apply_enrichment(
        db,
        publication,
        {
            "title": "Paper",
            "abstract": "New abstract",
            "publication_year": 2026,
            "venue": "Journal",
        },
        "crossref",
    )
    db.commit()

    assert publication.abstract == "New abstract"
    assert publication.venue == "Journal"
    assert publication.publication_year == 2025
    assert conflicts == 1
    conflict = db.scalar(
        select(MetadataConflict).where(
            MetadataConflict.publication_id == publication.id
        )
    )
    assert conflict.field_name == "publication_year"
    assert conflict.proposed_value == "2026"


def project_in_title_abstract(db, *, stage=ProjectStage.TITLE_ABSTRACT):
    admin = create_user(db, "admin", "Administrator", "secret-password", is_admin=True)
    reviewer = create_user(db, "reviewer", "Reviewer", "reviewer-password")
    project = Project(
        name="Test",
        review_type=ReviewType.SYSTEMATIC_REVIEW,
        random_seed="seed",
        stage=stage,
    )
    db.add(project)
    db.flush()
    db.add(
        ProjectMembership(
            project_id=project.id, user_id=reviewer.id, can_title_abstract_screen=True
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
    db.commit()
    return admin, reviewer, project


def test_publication_added_manually_after_title_abstract_started_gets_screened(
    client, db
) -> None:
    _, reviewer, project = project_in_title_abstract(db)
    csrf = login(client)

    created = client.post(
        f"/api/v1/projects/{project.id}/publications",
        json={"title": "Late arrival"},
        headers={"X-CSRF-Token": csrf},
    )
    assert created.status_code == 201
    publication_id = created.json()["id"]

    work_item = db.scalar(
        select(ScreeningWorkItem).where(
            ScreeningWorkItem.publication_id == publication_id,
            ScreeningWorkItem.stage == ScreeningStage.TITLE_ABSTRACT,
        )
    )
    assert work_item is not None
    assert work_item.assigned_reviewer_id == reviewer.id


def test_publication_import_after_title_abstract_started_gets_screened(db) -> None:
    _, reviewer, project = project_in_title_abstract(db)
    batch = ImportBatch(
        project_id=project.id,
        original_filename="records.csv",
        stored_path="/tmp/records.csv",
        file_type="csv",
        status=ImportStatus.COMPLETED,
        created_by_id=reviewer.id,
    )
    db.add(batch)
    db.flush()
    db.add(
        ImportedRecord(
            import_batch_id=batch.id,
            source_row=1,
            raw_data={"title": "Second batch paper"},
            parsed_data={"title": "Second batch paper"},
            validation_state="valid",
            warnings=[],
        )
    )
    db.commit()

    created = normalize_imported_records(db, batch.id)
    db.commit()
    assert created == 1

    publication = db.scalar(
        select(Publication).where(Publication.title == "Second batch paper")
    )
    work_item = db.scalar(
        select(ScreeningWorkItem).where(
            ScreeningWorkItem.publication_id == publication.id,
            ScreeningWorkItem.stage == ScreeningStage.TITLE_ABSTRACT,
        )
    )
    assert work_item is not None
    assert work_item.assigned_reviewer_id == reviewer.id


def test_publication_creation_blocked_once_full_text_has_started(client, db) -> None:
    _, _, project = project_in_title_abstract(db, stage=ProjectStage.FULL_TEXT)
    csrf = login(client)

    response = client.post(
        f"/api/v1/projects/{project.id}/publications",
        json={"title": "Too late"},
        headers={"X-CSRF-Token": csrf},
    )

    assert response.status_code == 400
    assert db.scalar(select(Publication).where(Publication.title == "Too late")) is None
