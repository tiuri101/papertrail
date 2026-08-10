from __future__ import annotations

import hashlib
from io import BytesIO

import pytest
from pypdf import PdfWriter
from sqlalchemy import func, select

from app.accounts.service import create_user
from app.audit.models import AuditEvent
from app.core.config import get_settings
from app.fulltext.models import PublicationDocument
from app.fulltext.storage import storage_path
from app.projects.models import Project, ProjectMembership, ReviewType
from app.publications.models import Publication


def pdf_bytes(*, title: str = "Test paper", doi: str = "10.1000/test") -> bytes:
    stream = BytesIO()
    writer = PdfWriter()
    writer.add_blank_page(width=72, height=72)
    writer.add_metadata(
        {"/Title": title, "/Author": "Doe, Jane", "/Subject": f"doi:{doi}"}
    )
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


def setup_project(db):
    reviewer = create_user(db, "reviewer", "Reviewer A", "reviewer-password")
    outsider = create_user(db, "outsider", "Outsider", "outsider-password")
    project = Project(
        name="PDF review", review_type=ReviewType.SYSTEMATIC_REVIEW, random_seed="seed"
    )
    db.add(project)
    db.flush()
    db.add(
        ProjectMembership(
            project_id=project.id,
            user_id=reviewer.id,
            can_full_text_screen=True,
        )
    )
    publication = Publication(
        project_id=project.id, title="Test paper", doi="10.1000/test"
    )
    db.add(publication)
    db.commit()
    return reviewer, outsider, project, publication


def login(client, username: str, password: str) -> str:
    return client.post(
        "/api/v1/auth/login", json={"username": username, "password": password}
    ).json()["csrfToken"]


def test_upload_view_replace_remove_and_history(client, db) -> None:
    reviewer, _, project, publication = setup_project(db)
    csrf = login(client, reviewer.username, "reviewer-password")
    first = pdf_bytes(title="Preprint")
    endpoint = f"/api/v1/projects/{project.id}/publications/{publication.id}/full-text"

    uploaded = client.post(
        endpoint,
        files={"file": ("../../preprint.pdf", first, "application/octet-stream")},
        headers={"X-CSRF-Token": csrf},
    )
    assert uploaded.status_code == 201
    document = uploaded.json()["document"]
    assert document["originalFilename"] == "preprint.pdf"
    assert document["sha256"] == hashlib.sha256(first).hexdigest()
    assert "storage" not in str(uploaded.json()).lower()

    row = db.get(PublicationDocument, document["id"])
    assert row is not None
    assert row.storage_key.endswith(f"/{row.id}.pdf")
    assert "preprint" not in row.storage_key
    assert storage_path(row.storage_key).read_bytes() == first
    publication_response = client.get(
        f"/api/v1/projects/{project.id}/publications/{publication.id}"
    )
    assert publication_response.json()["fullText"]["available"] is True
    assert publication_response.json()["fullText"]["document"]["id"] == row.id

    content = client.get(f"{endpoint}/content")
    assert content.status_code == 200
    assert content.headers["content-type"] == "application/pdf"
    assert content.headers["content-disposition"].startswith("inline")
    assert content.content == first

    duplicate = client.post(
        endpoint,
        files={"file": ("same.pdf", first, "application/pdf")},
        headers={"X-CSRF-Token": csrf},
    )
    assert duplicate.status_code == 409
    assert db.scalar(select(func.count()).select_from(PublicationDocument)) == 1

    failed_replacement = client.post(
        endpoint,
        files={"file": ("broken.pdf", b"%PDF-not-really%%EOF", "application/pdf")},
        headers={"X-CSRF-Token": csrf},
    )
    assert failed_replacement.status_code == 415
    db.expire_all()
    assert db.get(PublicationDocument, document["id"]).is_active is True
    assert client.get(f"{endpoint}/content").content == first

    second = pdf_bytes(title="Final", doi="10.1000/final")
    replaced = client.post(
        endpoint,
        files={"file": ("final.pdf", second, "application/pdf")},
        headers={"X-CSRF-Token": csrf},
    )
    assert replaced.status_code == 201
    replacement_id = replaced.json()["document"]["id"]
    db.expire_all()
    previous = db.get(PublicationDocument, document["id"])
    assert previous is not None and previous.is_active is False
    assert previous.replaced_by_document_id == replacement_id
    assert (
        db.scalar(
            select(func.count())
            .select_from(PublicationDocument)
            .where(
                PublicationDocument.publication_id == publication.id,
                PublicationDocument.is_active.is_(True),
            )
        )
        == 1
    )

    history = client.get(f"{endpoint}/history")
    assert history.status_code == 200
    assert [item["originalFilename"] for item in history.json()] == [
        "final.pdf",
        "preprint.pdf",
    ]

    removed = client.delete(endpoint, headers={"X-CSRF-Token": csrf})
    assert removed.status_code == 204
    assert client.get(endpoint).json() == {
        "available": False,
        "document": None,
        "retrievalStatus": None,
    }
    assert len(client.get(f"{endpoint}/history").json()) == 2
    actions = set(db.scalars(select(AuditEvent.action)))
    assert {"pdf.uploaded_manual", "pdf.replaced", "pdf.removed"} <= actions


def test_upload_validation_and_authorization(client, db) -> None:
    reviewer, outsider, project, publication = setup_project(db)
    endpoint = f"/api/v1/projects/{project.id}/publications/{publication.id}/full-text"
    reviewer_csrf = login(client, reviewer.username, "reviewer-password")

    empty = client.post(
        endpoint,
        files={"file": ("empty.pdf", b"", "application/pdf")},
        headers={"X-CSRF-Token": reviewer_csrf},
    )
    assert empty.status_code == 400
    fake = client.post(
        endpoint,
        files={"file": ("fake.pdf", b"not a pdf", "application/pdf")},
        headers={"X-CSRF-Token": reviewer_csrf},
    )
    assert fake.status_code == 415

    settings = get_settings()
    previous_limit = settings.max_pdf_size_mb
    settings.max_pdf_size_mb = 0
    try:
        oversized = client.post(
            endpoint,
            files={"file": ("large.pdf", pdf_bytes(), "application/pdf")},
            headers={"X-CSRF-Token": reviewer_csrf},
        )
        assert oversized.status_code == 413
    finally:
        settings.max_pdf_size_mb = previous_limit

    outsider_csrf = login(client, outsider.username, "outsider-password")
    assert client.get(endpoint).status_code == 403
    denied = client.post(
        endpoint,
        files={"file": ("paper.pdf", pdf_bytes(), "application/pdf")},
        headers={"X-CSRF-Token": outsider_csrf},
    )
    assert denied.status_code == 403
