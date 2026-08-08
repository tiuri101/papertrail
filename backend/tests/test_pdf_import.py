from __future__ import annotations

import zipfile
from io import BytesIO

import pytest
from pypdf import PdfWriter
from sqlalchemy import func, select

from app.accounts.service import create_user
from app.audit.models import AuditEvent
from app.core.config import get_settings
from app.deduplication.models import DuplicateCandidate
from app.deduplication.service import merge_publications
from app.fulltext.documents import attach_staged_pdf
from app.fulltext.models import DocumentSource, PublicationDocument
from app.fulltext.storage import stage_pdf_stream
from app.imports.models import ImportBatch, ImportedRecord, ImportPdfItem, PdfMatchStatus
from app.imports.pdf_import import process_pdf_matches, resolve_pdf_match
from app.imports.service import process_import_job
from app.jobs.models import BackgroundJob
from app.projects.models import Project, ProjectMembership, ReviewType
from app.publications.models import Publication, PublicationSource


def pdf_bytes(title: str, doi: str | None = None, author: str = "Doe, Jane") -> bytes:
    stream = BytesIO()
    writer = PdfWriter()
    writer.add_blank_page(width=72, height=72)
    metadata = {"/Title": title, "/Author": author}
    if doi:
        metadata["/Subject"] = f"https://doi.org/{doi}"
    writer.add_metadata(metadata)
    writer.write(stream)
    return stream.getvalue()


@pytest.fixture(autouse=True)
def isolated_pdf_storage(tmp_path):
    settings = get_settings()
    previous = settings.pdf_storage_path
    settings.pdf_storage_path = tmp_path / "pdfs"
    settings.pdf_storage_path.mkdir()
    try:
        yield
    finally:
        settings.pdf_storage_path = previous


def setup_batch(db):
    user = create_user(db, "owner", "Owner", "owner-password")
    project = Project(
        name="Bulk PDFs", review_type=ReviewType.SYSTEMATIC_REVIEW, random_seed="seed"
    )
    db.add(project)
    db.flush()
    db.add(ProjectMembership(project_id=project.id, user_id=user.id, is_owner=True))
    batch = ImportBatch(
        project_id=project.id,
        original_filename="records.csv",
        stored_path="unused.csv",
        file_type="csv",
        status="completed",
        created_by_id=user.id,
    )
    db.add(batch)
    db.flush()
    return user, project, batch


def add_batch_publication(db, batch, title, *, doi=None, authors="Doe, Jane", year=2026):
    record = ImportedRecord(
        import_batch_id=batch.id,
        source_row=1,
        raw_data={"title": title},
        parsed_data={"title": title},
    )
    publication = Publication(
        project_id=batch.project_id,
        title=title,
        doi=doi,
        authors=authors,
        publication_year=year,
    )
    db.add_all([record, publication])
    db.flush()
    db.add(PublicationSource(publication_id=publication.id, imported_record_id=record.id))
    db.flush()
    return publication


def add_item(db, batch, data, filename="paper.pdf"):
    staged = stage_pdf_stream(BytesIO(data), filename, import_batch_id=batch.id)
    item = ImportPdfItem(
        import_batch_id=batch.id,
        project_id=batch.project_id,
        original_filename=staged.original_filename,
        storage_key=staged.storage_key,
        mime_type="application/pdf",
        file_size=staged.file_size,
        sha256=staged.sha256,
        detected_doi=staged.detected_doi,
        detected_title=staged.detected_title,
        detected_authors=staged.detected_authors,
        detected_year=staged.detected_year,
    )
    db.add(item)
    db.flush()
    return item


def test_bulk_matching_by_doi_title_ambiguity_and_conflict(db) -> None:
    user, project, batch = setup_batch(db)
    doi_pub = add_batch_publication(db, batch, "DOI paper", doi="10.1000/exact")
    title_pub = add_batch_publication(db, batch, "Café – Urban Systems", doi=None)
    strong_pub = add_batch_publication(
        db, batch, "Immersive analytics for urban energy systems", doi=None
    )
    db.add(
        Publication(
            project_id=project.id,
            title="Outside this import batch",
            doi="10.1000/exact",
        )
    )
    doi_item = add_item(db, batch, pdf_bytes("Different title", "10.1000/exact"), "doi.pdf")
    title_item = add_item(db, batch, pdf_bytes("Café — Urban Systems"), "title.pdf")
    strong_item = add_item(
        db,
        batch,
        pdf_bytes("Immersive analytics for urban energy system"),
        "strong.pdf",
    )
    db.commit()

    summary = process_pdf_matches(db, batch)
    assert summary["matched"] == 3
    db.refresh(doi_item)
    db.refresh(title_item)
    db.refresh(strong_item)
    assert doi_item.matched_publication_id == doi_pub.id
    assert title_item.matched_publication_id == title_pub.id
    assert strong_item.matched_publication_id == strong_pub.id
    assert db.scalar(select(func.count()).select_from(PublicationDocument)) == 3

    ambiguous_batch = ImportBatch(
        project_id=project.id,
        original_filename="ambiguous.csv",
        stored_path="unused",
        file_type="csv",
        status="completed",
        created_by_id=user.id,
    )
    db.add(ambiguous_batch)
    db.flush()
    add_batch_publication(db, ambiguous_batch, "Same title")
    add_batch_publication(db, ambiguous_batch, "Same title")
    ambiguous = add_item(db, ambiguous_batch, pdf_bytes("Same title"))
    db.commit()
    process_pdf_matches(db, ambiguous_batch)
    db.refresh(ambiguous)
    assert ambiguous.status == PdfMatchStatus.AMBIGUOUS
    assert ambiguous.attached_document_id is None

    conflict = add_item(
        db,
        batch,
        pdf_bytes("DOI paper", "10.1000/exact", "Other Author"),
        "new.pdf",
    )
    db.commit()
    process_pdf_matches(db, batch)
    db.refresh(conflict)
    assert conflict.status == PdfMatchStatus.CONFLICT_EXISTING_PDF
    assert conflict.attached_document_id is None
    previous_document = db.scalar(
        select(PublicationDocument).where(
            PublicationDocument.publication_id == doi_pub.id,
            PublicationDocument.is_active.is_(True),
        )
    )
    resolve_pdf_match(
        db,
        conflict,
        publication=doi_pub,
        action="replace",
        user_id=user.id,
    )
    db.commit()
    db.refresh(previous_document)
    assert previous_document.is_active is False
    assert conflict.status == PdfMatchStatus.MATCHED
    assert db.scalar(
        select(AuditEvent.id).where(AuditEvent.action == "pdf.conflict_replaced")
    )


def test_manual_match_resolution_and_deduplication_preserve_documents(db) -> None:
    user, project, batch = setup_batch(db)
    canonical = add_batch_publication(db, batch, "Canonical")
    duplicate = add_batch_publication(db, batch, "Duplicate")
    item = add_item(db, batch, pdf_bytes("Unknown"), "unknown.pdf")
    db.commit()
    process_pdf_matches(db, batch)
    db.refresh(item)
    assert item.status == PdfMatchStatus.UNMATCHED

    resolve_pdf_match(db, item, publication=duplicate, action="attach", user_id=user.id)
    db.commit()
    assert item.status == PdfMatchStatus.MATCHED
    assert db.scalar(
        select(AuditEvent.id).where(AuditEvent.action == "pdf.match_resolved")
    )

    canonical_staged = stage_pdf_stream(
        BytesIO(pdf_bytes("Canonical final")), "canonical.pdf", import_batch_id=batch.id
    )
    attach_staged_pdf(
        db,
        project_id=project.id,
        publication_id=canonical.id,
        staged=canonical_staged,
        user_id=user.id,
        source=DocumentSource.BULK_IMPORT,
        import_batch_id=batch.id,
    )
    candidate = DuplicateCandidate(
        project_id=project.id,
        publication_a_id=canonical.id,
        publication_b_id=duplicate.id,
        match_reasons=["manual"],
        confidence=1.0,
    )
    db.add(candidate)
    db.flush()
    merge_publications(db, candidate, canonical.id, user.id)
    db.commit()

    documents = list(
        db.scalars(
            select(PublicationDocument).where(
                PublicationDocument.publication_id == canonical.id
            )
        )
    )
    assert len(documents) == 2
    assert sum(document.is_active for document in documents) == 1
    assert all(document.storage_key for document in documents)


def test_metadata_with_zip_isolated_failures_and_metadata_only_still_works(
    client, db
) -> None:
    owner = create_user(db, "zip-owner", "ZIP Owner", "owner-password")
    project = Project(
        name="ZIP import", review_type=ReviewType.SYSTEMATIC_REVIEW, random_seed="seed"
    )
    db.add(project)
    db.flush()
    db.add(ProjectMembership(project_id=project.id, user_id=owner.id, is_owner=True))
    db.commit()
    csrf = client.post(
        "/api/v1/auth/login",
        json={"username": owner.username, "password": "owner-password"},
    ).json()["csrfToken"]

    zip_pdf = pdf_bytes("ZIP Paper", "10.1000/zip")
    archive_stream = BytesIO()
    with zipfile.ZipFile(archive_stream, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("zip-paper.pdf", zip_pdf)
        archive.writestr("notes.txt", "not a PDF")
        archive.writestr("../escape.pdf", pdf_bytes("Escape"))
    response = client.post(
        f"/api/v1/projects/{project.id}/imports",
        files=[
            (
                "file",
                (
                    "records.csv",
                    b"title,doi,authors,year\nZIP Paper,10.1000/zip,Doe,2026\n",
                    "text/csv",
                ),
            ),
            ("pdfs", ("direct-paper.pdf", zip_pdf, "application/pdf")),
            ("pdfs", ("fake.pdf", b"not a PDF", "application/pdf")),
            (
                "pdfArchive",
                ("papers.zip", archive_stream.getvalue(), "application/zip"),
            ),
        ],
        headers={"X-CSRF-Token": csrf},
    )
    assert response.status_code == 202
    job = db.get(BackgroundJob, response.json()["jobId"])
    assert job is not None
    result = process_import_job(db, job)
    assert result["pdfs"]["matched"] == 1
    assert result["pdfs"]["duplicate"] == 1
    assert result["pdfs"]["invalid"] == 3
    assert db.scalar(select(func.count()).select_from(PublicationDocument)) == 1

    metadata_only = client.post(
        f"/api/v1/projects/{project.id}/imports",
        files={"file": ("only.csv", b"title\nMetadata only\n", "text/csv")},
        headers={"X-CSRF-Token": csrf},
    )
    assert metadata_only.status_code == 202
    second_job = db.get(BackgroundJob, metadata_only.json()["jobId"])
    assert second_job is not None
    second_result = process_import_job(db, second_job)
    assert second_result["pdfs"]["total"] == 0

    settings = get_settings()
    previous_expanded_limit = settings.max_pdf_zip_expanded_bytes
    settings.max_pdf_zip_expanded_bytes = 1
    try:
        suspicious = client.post(
            f"/api/v1/projects/{project.id}/imports",
            files=[
                ("file", ("bomb.csv", b"title\nBomb test\n", "text/csv")),
                (
                    "pdfArchive",
                    ("bomb.zip", archive_stream.getvalue(), "application/zip"),
                ),
            ],
            headers={"X-CSRF-Token": csrf},
        )
        bomb_job = db.get(BackgroundJob, suspicious.json()["jobId"])
        assert bomb_job is not None
        bomb_result = process_import_job(db, bomb_job)
        assert bomb_result["pdfs"]["invalid"] == 1
        assert bomb_result["pdfs"]["matched"] == 0
    finally:
        settings.max_pdf_zip_expanded_bytes = previous_expanded_limit
