from sqlalchemy import select

from app.accounts.service import create_user
from app.imports.models import ImportBatch, ImportedRecord, ImportStatus
from app.projects.models import Project, ReviewType
from app.publications.models import MetadataConflict, Publication, PublicationSource
from app.publications.service import apply_enrichment, normalize_imported_records


def login(client) -> str:
    response = client.post("/api/v1/auth/login", json={"username": "admin", "password": "secret-password"})
    return response.json()["csrfToken"]


def test_delete_publication_soft_deletes_and_hides_it_from_the_list(client, db) -> None:
    create_user(db, "admin", "Administrator", "secret-password", is_admin=True)
    project = Project(name="Review", review_type=ReviewType.SYSTEMATIC_REVIEW, random_seed="seed")
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
    assert client.get(f"/api/v1/projects/{project.id}/publications/{publication_id}").status_code == 200

    again = client.delete(
        f"/api/v1/projects/{project.id}/publications/{publication_id}",
        headers={"X-CSRF-Token": csrf},
    )
    assert again.status_code == 404


def project_and_batch(db):
    admin = create_user(db, "admin", "Administrator", "secret-password", is_admin=True)
    project = Project(name="Review", review_type=ReviewType.SYSTEMATIC_REVIEW, random_seed="seed")
    db.add_all([project])
    db.flush()
    batch = ImportBatch(project_id=project.id, original_filename="records.csv", stored_path="/tmp/records.csv", file_type="csv", status=ImportStatus.COMPLETED, created_by_id=admin.id)
    db.add(batch)
    db.flush()
    return admin, project, batch


def test_normalization_creates_publication_and_preserves_source(db) -> None:
    _, project, batch = project_and_batch(db)
    record = ImportedRecord(import_batch_id=batch.id, source_row=2, raw_data={"DOI": "https://doi.org/10.1000/ABC"}, parsed_data={"title": "  A  Paper ", "authors": "Doe, Jane", "doi": "https://doi.org/10.1000/ABC", "year": "2026"}, validation_state="valid", warnings=[])
    db.add(record)
    db.commit()

    created = normalize_imported_records(db, batch.id)
    db.commit()

    assert created == 1
    publication = db.scalar(select(Publication).where(Publication.project_id == project.id))
    assert publication is not None
    assert publication.title == "A Paper"
    assert publication.doi == "10.1000/abc"
    assert publication.publication_year == 2026
    source = db.scalar(select(PublicationSource).where(PublicationSource.publication_id == publication.id))
    assert source.imported_record_id == record.id


def test_enrichment_fills_missing_fields_and_records_important_conflicts(db) -> None:
    _, project, _ = project_and_batch(db)
    publication = Publication(project_id=project.id, title="Paper", authors="Doe", publication_year=2025)
    db.add(publication)
    db.flush()

    conflicts = apply_enrichment(db, publication, {"title": "Paper", "abstract": "New abstract", "publication_year": 2026, "venue": "Journal"}, "crossref")
    db.commit()

    assert publication.abstract == "New abstract"
    assert publication.venue == "Journal"
    assert publication.publication_year == 2025
    assert conflicts == 1
    conflict = db.scalar(select(MetadataConflict).where(MetadataConflict.publication_id == publication.id))
    assert conflict.field_name == "publication_year"
    assert conflict.proposed_value == "2026"
