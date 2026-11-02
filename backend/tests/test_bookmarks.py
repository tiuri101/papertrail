from __future__ import annotations

import zipfile
from datetime import timedelta
from io import BytesIO

from app.accounts.service import create_user
from app.bookmarks.exports import bookmark_export_path, export_bookmarks_job
from app.core.config import get_settings
from app.fulltext.models import PublicationDocument
from app.jobs.models import BackgroundJob, JobStatus
from app.projects.models import Project, ProjectMembership, ReviewType
from app.publications.deletion import remove_publications_from_review
from app.publications.models import Publication
from tests.security.helpers import (
    OWNER_PASSWORD,
    REVIEWER_PASSWORD,
    build_review_project,
    login,
)


def _bookmark_url(project_id: str, publication_id: str) -> str:
    return f"/api/v1/projects/{project_id}/publications/{publication_id}/bookmark"


def _ids(client, project_id: str) -> list[str]:
    response = client.get(f"/api/v1/projects/{project_id}/bookmarks/ids")
    assert response.status_code == 200, response.text
    return list(response.json()["publicationIds"])


def test_bookmark_toggle_is_idempotent(client, db):
    fixture = build_review_project(db)
    project_id = fixture.project.id
    paper = fixture.publications[0]
    csrf = login(client, "sec-owner", OWNER_PASSWORD)
    headers = {"X-CSRF-Token": csrf}

    assert _ids(client, project_id) == []
    for _ in range(2):
        response = client.put(_bookmark_url(project_id, paper.id), headers=headers)
        assert response.status_code == 204, response.text
    assert _ids(client, project_id) == [paper.id]

    for _ in range(2):
        response = client.delete(_bookmark_url(project_id, paper.id), headers=headers)
        assert response.status_code == 204, response.text
    assert _ids(client, project_id) == []


def test_bookmark_requires_csrf(client, db):
    fixture = build_review_project(db)
    login(client, "sec-owner", OWNER_PASSWORD)
    response = client.put(
        _bookmark_url(fixture.project.id, fixture.publications[0].id)
    )
    assert response.status_code == 403


def test_bookmark_rejects_publication_from_another_project(client, db):
    fixture = build_review_project(db)
    other = Project(
        name="Other", review_type=ReviewType.SYSTEMATIC_REVIEW, random_seed="o"
    )
    db.add(other)
    db.flush()
    foreign = Publication(project_id=other.id, title="Foreign paper")
    db.add(foreign)
    db.commit()
    csrf = login(client, "sec-owner", OWNER_PASSWORD)

    response = client.put(
        _bookmark_url(fixture.project.id, foreign.id),
        headers={"X-CSRF-Token": csrf},
    )
    assert response.status_code == 404


def test_non_member_cannot_bookmark_or_list(client, db):
    fixture = build_review_project(db)
    create_user(db, "outsider", "Outsider", "outsider-password-value")
    db.commit()
    csrf = login(client, "outsider", "outsider-password-value")
    project_id = fixture.project.id

    response = client.put(
        _bookmark_url(project_id, fixture.publications[0].id),
        headers={"X-CSRF-Token": csrf},
    )
    assert response.status_code == 403
    response = client.get(f"/api/v1/projects/{project_id}/bookmarks/ids")
    assert response.status_code == 403


def test_bookmarks_are_private_per_user(client, db):
    fixture = build_review_project(db)
    project_id = fixture.project.id
    csrf = login(client, "sec-owner", OWNER_PASSWORD)
    client.put(
        _bookmark_url(project_id, fixture.publications[0].id),
        headers={"X-CSRF-Token": csrf},
    )

    login(client, "sec-reviewer", REVIEWER_PASSWORD)
    assert _ids(client, project_id) == []
    assert client.get("/api/v1/bookmarks").json() == []


def test_bookmark_list_spans_projects_and_drops_lost_access(client, db):
    fixture = build_review_project(db)
    second = Project(
        name="Second", review_type=ReviewType.SYSTEMATIC_REVIEW, random_seed="s"
    )
    db.add(second)
    db.flush()
    second_membership = ProjectMembership(
        project_id=second.id, user_id=fixture.reviewer.id
    )
    db.add(second_membership)
    second_paper = Publication(
        project_id=second.id,
        title="Second paper",
        authors="Doe, J.",
        publication_year=2024,
        venue="Journal",
        doi="10.1/second",
    )
    db.add(second_paper)
    db.commit()

    csrf = login(client, "sec-reviewer", REVIEWER_PASSWORD)
    headers = {"X-CSRF-Token": csrf}
    first_paper = fixture.publications[0]
    client.put(_bookmark_url(fixture.project.id, first_paper.id), headers=headers)
    client.put(_bookmark_url(second.id, second_paper.id), headers=headers)

    items = client.get("/api/v1/bookmarks").json()
    assert {item["publicationId"] for item in items} == {
        first_paper.id,
        second_paper.id,
    }
    second_item = next(i for i in items if i["publicationId"] == second_paper.id)
    assert second_item == {
        "publicationId": second_paper.id,
        "projectId": second.id,
        "title": "Second paper",
        "authors": "Doe, J.",
        "publicationYear": 2024,
        "venue": "Journal",
        "doi": "10.1/second",
        "publisherUrl": None,
        "bookmarkedAt": second_item["bookmarkedAt"],
    }

    db.delete(db.get(ProjectMembership, second_membership.id))
    db.commit()
    items = client.get("/api/v1/bookmarks").json()
    assert [item["publicationId"] for item in items] == [first_paper.id]


def test_bookmark_follows_merge_and_hides_deleted(client, db):
    fixture = build_review_project(db, publication_count=3)
    project_id = fixture.project.id
    canonical, duplicate, deleted = fixture.publications
    csrf = login(client, "sec-owner", OWNER_PASSWORD)
    headers = {"X-CSRF-Token": csrf}
    client.put(_bookmark_url(project_id, duplicate.id), headers=headers)
    client.put(_bookmark_url(project_id, deleted.id), headers=headers)

    duplicate.is_active = False
    duplicate.merged_into_id = canonical.id
    remove_publications_from_review(db, project_id, [deleted])
    db.commit()

    assert _ids(client, project_id) == [canonical.id]
    items = client.get("/api/v1/bookmarks").json()
    assert [item["publicationId"] for item in items] == [canonical.id]

    # Removing the bookmark on the canonical paper clears the one made on
    # the paper merged into it.
    client.delete(_bookmark_url(project_id, canonical.id), headers=headers)
    assert _ids(client, project_id) == []


def test_bulk_remove_clears_selected_bookmarks_only(client, db):
    fixture = build_review_project(db, publication_count=3)
    project_id = fixture.project.id
    first, second, third = fixture.publications
    csrf = login(client, "sec-owner", OWNER_PASSWORD)
    headers = {"X-CSRF-Token": csrf}
    for paper in (first, second, third):
        client.put(_bookmark_url(project_id, paper.id), headers=headers)
    # A bookmark on a paper merged into `first` goes with it.
    second.is_active = False
    second.merged_into_id = first.id
    db.commit()

    response = client.post(
        "/api/v1/bookmarks/remove",
        json={"publicationIds": [first.id, "unknown-id"]},
        headers=headers,
    )
    assert response.status_code == 200, response.text
    assert response.json() == {"removedCount": 1}
    assert _ids(client, project_id) == [third.id]


def test_bulk_remove_requires_csrf(client, db):
    fixture = build_review_project(db)
    login(client, "sec-owner", OWNER_PASSWORD)
    response = client.post(
        "/api/v1/bookmarks/remove",
        json={"publicationIds": [fixture.publications[0].id]},
    )
    assert response.status_code == 403


def _attach_pdf(db, publication, uploader_id, root):
    storage_key = f"projects/{publication.project_id}/{publication.id}.pdf"
    path = root / storage_key
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"%PDF-1.4 fake pdf content")
    db.add(
        PublicationDocument(
            project_id=publication.project_id,
            publication_id=publication.id,
            original_filename="document.pdf",
            storage_key=storage_key,
            mime_type="application/pdf",
            file_size=path.stat().st_size,
            sha256=publication.id.replace("-", "")[:1] * 64,
            uploaded_by_user_id=uploader_id,
        )
    )


def test_bookmark_export_bundles_bibtex_and_pdfs_for_its_owner(
    client, db, tmp_path, monkeypatch
):
    settings = get_settings()
    monkeypatch.setattr(settings, "export_dir", tmp_path / "exports")
    monkeypatch.setattr(settings, "pdf_storage_path", tmp_path / "pdfs")
    fixture = build_review_project(db, publication_count=3)
    project_id = fixture.project.id
    with_pdf, without_pdf, not_selected = fixture.publications
    _attach_pdf(db, with_pdf, fixture.owner.id, tmp_path / "pdfs")
    db.commit()
    csrf = login(client, "sec-owner", OWNER_PASSWORD)
    headers = {"X-CSRF-Token": csrf}
    for paper in fixture.publications:
        client.put(_bookmark_url(project_id, paper.id), headers=headers)

    response = client.post(
        "/api/v1/bookmarks/exports",
        json={"publicationIds": [with_pdf.id, without_pdf.id]},
        headers=headers,
    )
    assert response.status_code == 202, response.text
    job_id = response.json()["jobId"]
    status_url = f"/api/v1/bookmarks/exports/{job_id}"
    assert client.get(status_url).json()["status"] == "queued"

    job = db.get(BackgroundJob, job_id)
    job.result = export_bookmarks_job(db, job)
    job.status = JobStatus.COMPLETED
    db.commit()

    status_body = client.get(status_url).json()
    assert status_body["status"] == "completed"
    assert status_body["publicationCount"] == 2
    download = client.get(f"{status_url}/download")
    assert download.status_code == 200
    with zipfile.ZipFile(BytesIO(download.content)) as archive:
        names = archive.namelist()
        bibtex = archive.read("metadata.bib").decode()
        missing = archive.read("MISSING_PDFS.txt").decode()
    assert len([name for name in names if name.endswith(".pdf")]) == 1
    assert with_pdf.title in bibtex and without_pdf.title in bibtex
    assert not_selected.title not in bibtex
    assert without_pdf.title in missing

    # Nobody else can see or download it.
    login(client, "sec-reviewer", REVIEWER_PASSWORD)
    assert client.get(status_url).status_code == 404
    assert client.get(f"{status_url}/download").status_code == 404


def test_bookmark_export_only_contains_current_bookmarks(
    client, db, tmp_path, monkeypatch
):
    settings = get_settings()
    monkeypatch.setattr(settings, "export_dir", tmp_path / "exports")
    fixture = build_review_project(db, publication_count=2)
    bookmarked, other = fixture.publications
    csrf = login(client, "sec-owner", OWNER_PASSWORD)
    headers = {"X-CSRF-Token": csrf}
    client.put(_bookmark_url(fixture.project.id, bookmarked.id), headers=headers)

    response = client.post(
        "/api/v1/bookmarks/exports",
        json={"publicationIds": [other.id]},
        headers=headers,
    )
    assert response.status_code == 400

    # Exporting "all" ignores publications that aren't bookmarked, and a
    # newer export replaces the previous file on disk.
    first_job = db.get(
        BackgroundJob,
        client.post("/api/v1/bookmarks/exports", json={}, headers=headers).json()["jobId"],
    )
    export_bookmarks_job(db, first_job)
    second_job = db.get(
        BackgroundJob,
        client.post("/api/v1/bookmarks/exports", json={}, headers=headers).json()["jobId"],
    )
    second_job.created_at = first_job.created_at + timedelta(seconds=1)
    result = export_bookmarks_job(db, second_job)
    assert result["publicationCount"] == 1
    assert not bookmark_export_path(first_job.id).exists()
    with zipfile.ZipFile(bookmark_export_path(second_job.id)) as archive:
        bibtex = archive.read("metadata.bib").decode()
    assert bookmarked.title in bibtex and other.title not in bibtex
