from io import BytesIO

import pytest
from openpyxl import Workbook
from pypdf import PdfWriter
from sqlalchemy import select

from app.accounts.service import create_user
from app.core.config import get_settings
from app.imports.adapters import parse_bibtex, parse_csv, parse_ris, parse_xlsx
from app.imports.models import ImportBatch, ImportedRecord, SearchSource
from app.jobs.worker import execute_next_job
from app.publications.models import Publication, PublicationSource
from app.publications.service import normalize_imported_records
from app.screening.models import (
    ScreeningDecision,
    ScreeningOutcome,
    ScreeningWorkItem,
    WorkItemStatus,
)


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


def pdf_bytes(title: str) -> bytes:
    stream = BytesIO()
    writer = PdfWriter()
    writer.add_blank_page(width=72, height=72)
    writer.add_metadata({"/Title": title})
    writer.write(stream)
    return stream.getvalue()


def login(client) -> str:
    response = client.post(
        "/api/v1/auth/login", json={"username": "admin", "password": "secret-password"}
    )
    return response.json()["csrfToken"]


def create_project(client, csrf: str) -> str:
    return client.post(
        "/api/v1/projects",
        json={"name": "Review", "reviewType": "systematic_review"},
        headers={"X-CSRF-Token": csrf},
    ).json()["id"]


def test_adapters_parse_supported_formats() -> None:
    csv_rows = parse_csv(b"Title,Authors,Abstract,DOI\nPaper A,Doe,Summary,10.1/a\n")
    assert csv_rows[0]["Title"] == "Paper A"

    ris_rows = parse_ris(
        b"TY  - JOUR\nTI  - Paper B\nAU  - Doe, Jane\nDO  - 10.1/b\nER  -\n"
    )
    assert ris_rows[0]["title"] == "Paper B"
    assert ris_rows[0]["authors"] == "Doe, Jane"

    bib_rows = parse_bibtex(
        b"@article{doe2026, title={Paper C}, author={Doe, Jane}, year={2026}}"
    )
    assert bib_rows[0]["title"] == "Paper C"

    workbook = Workbook()
    sheet = workbook.active
    sheet.append(["Title", "Authors"])
    sheet.append(["Paper D", "Doe"])
    buffer = BytesIO()
    workbook.save(buffer)
    assert parse_xlsx(buffer.getvalue())[0]["Title"] == "Paper D"


def test_documented_searches_are_listed_for_a_project(client, db) -> None:
    admin = create_user(db, "admin", "Administrator", "secret-password", is_admin=True)
    db.commit()
    csrf = login(client)
    project_id = create_project(client, csrf)

    assert client.get(f"/api/v1/projects/{project_id}/searches").json() == []

    created = client.post(
        f"/api/v1/projects/{project_id}/searches",
        json={
            "sourceName": "IEEE Xplore",
            "query": "virtual reality AND urban",
            "searchDate": "2026-07-30",
            "filters": "Journals and conferences",
            "exportedResultCount": 1,
        },
        headers={"X-CSRF-Token": csrf},
    )
    assert created.status_code == 201

    listed = client.get(f"/api/v1/projects/{project_id}/searches")
    assert listed.status_code == 200
    assert len(listed.json()) == 1
    assert listed.json()[0]["sourceName"] == "IEEE Xplore"
    assert listed.json()[0]["query"] == "virtual reality AND urban"
    assert listed.json()[0]["createdBy"] == {
        "id": admin.id,
        "displayName": "Administrator",
        "username": "admin",
    }
    assert listed.json()[0]["createdAt"]


def test_documenting_a_search_no_longer_requires_an_exported_result_count(
    client, db
) -> None:
    create_user(db, "admin", "Administrator", "secret-password", is_admin=True)
    db.commit()
    csrf = login(client)
    project_id = create_project(client, csrf)

    created = client.post(
        f"/api/v1/projects/{project_id}/searches",
        json={
            "sourceName": "Scopus",
            "query": "urban AND visualization",
            "searchDate": "2026-07-30",
        },
        headers={"X-CSRF-Token": csrf},
    )
    assert created.status_code == 201
    assert created.json()["exportedResultCount"] == 0


def test_project_jobs_are_listed_with_status(
    client, db, session_factory, tmp_path, monkeypatch
) -> None:
    create_user(db, "admin", "Administrator", "secret-password", is_admin=True)
    db.commit()
    csrf = login(client)
    project_id = create_project(client, csrf)

    monkeypatch.setenv("PAPERTRAIL_IMPORT_DIR", str(tmp_path / "imports"))
    from app.core.config import get_settings

    get_settings.cache_clear()

    response = client.post(
        f"/api/v1/projects/{project_id}/imports",
        files={"file": ("records.csv", b"Title,Authors\nPaper A,Doe\n", "text/csv")},
        headers={"X-CSRF-Token": csrf},
    )
    assert response.status_code == 202

    jobs = client.get(f"/api/v1/projects/{project_id}/jobs")
    assert jobs.status_code == 200
    assert len(jobs.json()) == 1
    assert jobs.json()[0]["jobType"] == "parse_import"
    assert jobs.json()[0]["status"] == "queued"

    assert execute_next_job(session_factory, worker_id="test-worker") is True
    jobs_after = client.get(f"/api/v1/projects/{project_id}/jobs")
    assert jobs_after.json()[0]["status"] == "completed"
    assert jobs_after.json()[0]["completedAt"] is not None


def test_pdfs_can_be_bulk_attached_to_a_previously_completed_search_import(
    client, db, session_factory, tmp_path, monkeypatch
) -> None:
    create_user(db, "admin", "Administrator", "secret-password", is_admin=True)
    db.commit()
    csrf = login(client)
    project_id = create_project(client, csrf)

    monkeypatch.setenv("PAPERTRAIL_IMPORT_DIR", str(tmp_path / "imports"))
    from app.core.config import get_settings

    get_settings.cache_clear()

    search = client.post(
        f"/api/v1/projects/{project_id}/searches",
        json={
            "sourceName": "IEEE Xplore",
            "query": "virtual reality",
            "searchDate": "2026-07-30",
        },
        headers={"X-CSRF-Token": csrf},
    ).json()

    response = client.post(
        f"/api/v1/projects/{project_id}/imports",
        data={"searchSourceId": search["id"]},
        files={"file": ("records.csv", b"Title,Authors\nPaper A,Doe\n", "text/csv")},
        headers={"X-CSRF-Token": csrf},
    )
    assert response.status_code == 202
    import_batch_id = response.json()["importBatchId"]
    assert execute_next_job(session_factory, worker_id="test-worker") is True

    listed = client.get(f"/api/v1/projects/{project_id}/searches").json()
    assert len(listed) == 1
    batches = listed[0]["importBatches"]
    assert len(batches) == 1
    assert batches[0]["id"] == import_batch_id
    assert batches[0]["status"] == "completed"
    assert batches[0]["originalFilename"] == "records.csv"
    assert batches[0]["attachedPaperCount"] == 0

    attach = client.post(
        f"/api/v1/projects/{project_id}/imports/{import_batch_id}/pdfs",
        files={"pdfs": ("paper-a.pdf", pdf_bytes("Paper A"), "application/pdf")},
        headers={"X-CSRF-Token": csrf},
    )
    assert attach.status_code == 200
    assert attach.json()["summary"]["total"] == 1
    listed_after_attach = client.get(f"/api/v1/projects/{project_id}/searches").json()
    assert listed_after_attach[0]["importBatches"][0]["attachedPaperCount"] == 1


def test_a_regular_project_member_can_document_a_search_and_import_records(
    client, db, session_factory, tmp_path, monkeypatch
) -> None:
    create_user(db, "admin", "Administrator", "secret-password", is_admin=True)
    member = create_user(db, "reviewer", "Reviewer One", "secret-password")
    db.commit()
    admin_csrf = login(client)
    project_id = create_project(client, admin_csrf)

    added = client.post(
        f"/api/v1/projects/{project_id}/members",
        json={"userId": member.id},
        headers={"X-CSRF-Token": admin_csrf},
    )
    assert added.status_code == 201

    member_csrf = client.post(
        "/api/v1/auth/login",
        json={"username": "reviewer", "password": "secret-password"},
    ).json()["csrfToken"]

    monkeypatch.setenv("PAPERTRAIL_IMPORT_DIR", str(tmp_path / "imports"))
    from app.core.config import get_settings

    get_settings.cache_clear()

    search = client.post(
        f"/api/v1/projects/{project_id}/searches",
        json={
            "sourceName": "IEEE Xplore",
            "query": "virtual reality AND urban",
            "searchDate": "2026-07-30",
        },
        headers={"X-CSRF-Token": member_csrf},
    )
    assert search.status_code == 201

    response = client.post(
        f"/api/v1/projects/{project_id}/imports",
        data={"searchSourceId": search.json()["id"]},
        files={"file": ("records.csv", b"Title,Authors\nPaper A,Doe\n", "text/csv")},
        headers={"X-CSRF-Token": member_csrf},
    )
    assert response.status_code == 202


def test_csv_import_runs_through_persistent_job(
    client, db, session_factory, tmp_path, monkeypatch
) -> None:
    create_user(db, "admin", "Administrator", "secret-password", is_admin=True)
    db.commit()
    csrf = login(client)
    project_id = create_project(client, csrf)

    search = client.post(
        f"/api/v1/projects/{project_id}/searches",
        json={
            "sourceName": "IEEE Xplore",
            "query": "virtual reality AND urban",
            "searchDate": "2026-07-30",
            "filters": "Journals and conferences",
            "exportedResultCount": 1,
        },
        headers={"X-CSRF-Token": csrf},
    )
    assert search.status_code == 201

    monkeypatch.setenv("PAPERTRAIL_IMPORT_DIR", str(tmp_path / "imports"))
    from app.core.config import get_settings

    get_settings.cache_clear()

    response = client.post(
        f"/api/v1/projects/{project_id}/imports",
        data={"searchSourceId": search.json()["id"]},
        files={
            "file": (
                "ieee.csv",
                b"Document Title,Authors,Abstract,DOI\nPaper A,Doe,Summary,10.1/a\n",
                "text/csv",
            )
        },
        headers={"X-CSRF-Token": csrf},
    )
    assert response.status_code == 202
    job_id = response.json()["jobId"]

    assert execute_next_job(session_factory, worker_id="test-worker") is True
    db.expire_all()
    batch = db.scalar(select(ImportBatch).where(ImportBatch.project_id == project_id))
    assert batch is not None
    assert batch.status == "completed"
    records = list(
        db.scalars(
            select(ImportedRecord).where(ImportedRecord.import_batch_id == batch.id)
        )
    )
    assert len(records) == 1
    assert records[0].parsed_data["title"] == "Paper A"

    job = client.get(f"/api/v1/jobs/{job_id}")
    assert job.status_code == 200
    assert job.json()["status"] == "completed"


def _make_batch(
    db, project_id: str, created_by_id: str, search_id: str, tmp_path, name: str
) -> ImportBatch:
    batch = ImportBatch(
        project_id=project_id,
        search_source_id=search_id,
        original_filename=name,
        stored_path=str(tmp_path / name),
        file_type="csv",
        status="completed",
        created_by_id=created_by_id,
    )
    db.add(batch)
    db.flush()
    return batch


def test_deleting_a_search_removes_its_exclusive_papers_but_keeps_shared_ones(
    client, db, tmp_path
) -> None:
    admin = create_user(db, "admin", "Administrator", "secret-password", is_admin=True)
    db.commit()
    csrf = login(client)
    project_id = create_project(client, csrf)

    search_a = client.post(
        f"/api/v1/projects/{project_id}/searches",
        json={
            "sourceName": "IEEE Xplore",
            "query": "virtual reality",
            "searchDate": "2026-07-30",
            "exportedResultCount": 2,
        },
        headers={"X-CSRF-Token": csrf},
    ).json()
    search_b = client.post(
        f"/api/v1/projects/{project_id}/searches",
        json={
            "sourceName": "PubMed",
            "query": "virtual reality",
            "searchDate": "2026-07-31",
            "exportedResultCount": 1,
        },
        headers={"X-CSRF-Token": csrf},
    ).json()

    batch_a = _make_batch(db, project_id, admin.id, search_a["id"], tmp_path, "a.csv")
    batch_b = _make_batch(db, project_id, admin.id, search_b["id"], tmp_path, "b.csv")

    record_exclusive = ImportedRecord(
        import_batch_id=batch_a.id,
        source_row=1,
        raw_data={"title": "Exclusive paper"},
        parsed_data={"title": "Exclusive paper"},
        validation_state="valid",
        warnings=[],
    )
    record_shared_a = ImportedRecord(
        import_batch_id=batch_a.id,
        source_row=2,
        raw_data={"title": "Shared paper"},
        parsed_data={"title": "Shared paper"},
        validation_state="valid",
        warnings=[],
    )
    record_shared_b = ImportedRecord(
        import_batch_id=batch_b.id,
        source_row=1,
        raw_data={"title": "Shared paper"},
        parsed_data={"title": "Shared paper"},
        validation_state="valid",
        warnings=[],
    )
    db.add_all([record_exclusive, record_shared_a, record_shared_b])
    db.commit()

    normalize_imported_records(db, batch_a.id)
    normalize_imported_records(db, batch_b.id)
    db.commit()

    # Simulate what a duplicate merge does: the two "Shared paper" imports
    # collapse onto one canonical publication with sources from both batches.
    source_a = db.scalar(
        select(PublicationSource).where(
            PublicationSource.imported_record_id == record_shared_a.id
        )
    )
    source_b = db.scalar(
        select(PublicationSource).where(
            PublicationSource.imported_record_id == record_shared_b.id
        )
    )
    canonical = db.get(Publication, source_a.publication_id)
    duplicate = db.get(Publication, source_b.publication_id)
    source_b.publication_id = canonical.id
    duplicate.is_active = False
    duplicate.merged_into_id = canonical.id
    db.commit()

    canonical_id = canonical.id
    batch_a_id = batch_a.id
    batch_b_id = batch_b.id
    record_shared_b_id = record_shared_b.id
    exclusive_pub_id = db.scalar(
        select(Publication.id).where(Publication.title == "Exclusive paper")
    )

    preview = client.delete(
        f"/api/v1/projects/{project_id}/searches/{search_a['id']}",
        headers={"X-CSRF-Token": csrf},
    )
    assert preview.status_code == 200
    preview_body = preview.json()
    assert preview_body["deleted"] is False
    assert preview_body["requiresConfirmation"] is True
    assert preview_body["publicationCount"] == 1
    assert preview_body["screenedPublicationCount"] == 0

    response = client.delete(
        f"/api/v1/projects/{project_id}/searches/{search_a['id']}",
        params={"force": "true"},
        headers={"X-CSRF-Token": csrf},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["deleted"] is True
    assert body["publicationCount"] == 1
    assert body["screenedPublicationCount"] == 0

    db.expire_all()
    assert db.get(Publication, exclusive_pub_id).is_active is False
    assert db.get(Publication, canonical_id).is_active is True
    remaining_sources = list(
        db.scalars(
            select(PublicationSource).where(
                PublicationSource.publication_id == canonical_id
            )
        )
    )
    assert len(remaining_sources) == 1
    assert remaining_sources[0].imported_record_id == record_shared_b_id

    assert db.get(SearchSource, search_a["id"]) is None
    assert db.get(ImportBatch, batch_a_id) is None
    assert db.get(SearchSource, search_b["id"]) is not None
    assert db.get(ImportBatch, batch_b_id) is not None


def test_deleting_a_search_removes_its_import_files_and_staged_pdfs(
    client, db, tmp_path, monkeypatch
) -> None:
    """The uploaded source file and the batch's staging directory are the only
    things that knew about those bytes, so deleting the rows without deleting
    the files leaves orphans nothing can ever find again. They are removed
    after the commit, never before it."""
    settings = get_settings()
    monkeypatch.setattr(settings, "import_dir", tmp_path / "imports")
    settings.import_dir.mkdir(parents=True, exist_ok=True)
    admin = create_user(db, "admin", "Administrator", "secret-password", is_admin=True)
    db.commit()
    csrf = login(client)
    project_id = create_project(client, csrf)

    search = client.post(
        f"/api/v1/projects/{project_id}/searches",
        json={
            "sourceName": "Scopus",
            "query": "urban vr",
            "searchDate": "2026-08-01",
            "exportedResultCount": 1,
        },
        headers={"X-CSRF-Token": csrf},
    ).json()

    project_import_dir = settings.import_dir / project_id
    project_import_dir.mkdir(parents=True)
    source_file = project_import_dir / "scopus.csv"
    source_file.write_text("Title\nA paper\n", encoding="utf-8")
    kept_file = project_import_dir / "another-search.csv"
    kept_file.write_text("Title\nOther\n", encoding="utf-8")
    batch = ImportBatch(
        project_id=project_id,
        search_source_id=search["id"],
        original_filename="scopus.csv",
        stored_path=str(source_file),
        file_type="csv",
        status="completed",
        created_by_id=admin.id,
    )
    db.add(batch)
    db.commit()
    staging_directory = settings.pdf_storage_path / "staging" / "imports" / batch.id
    staging_directory.mkdir(parents=True)
    (staging_directory / "unresolved.pdf").write_bytes(b"staged PDF")

    # A preview (force omitted) deletes nothing at all, files included.
    preview = client.delete(
        f"/api/v1/projects/{project_id}/searches/{search['id']}",
        headers={"X-CSRF-Token": csrf},
    )
    assert preview.json()["deleted"] is False
    assert source_file.exists()
    assert staging_directory.exists()

    deleted = client.delete(
        f"/api/v1/projects/{project_id}/searches/{search['id']}",
        params={"force": "true"},
        headers={"X-CSRF-Token": csrf},
    )
    assert deleted.status_code == 200
    assert deleted.json()["deleted"] is True

    assert not source_file.exists()
    assert not staging_directory.exists()
    # Only this search's files go: the project's own import directory and
    # another search's upload stay.
    assert kept_file.exists()
    assert project_import_dir.exists()


def test_deleting_a_search_with_screened_papers_requires_confirmation(
    client, db, tmp_path
) -> None:
    admin = create_user(db, "admin", "Administrator", "secret-password", is_admin=True)
    db.commit()
    csrf = login(client)
    project_id = create_project(client, csrf)

    search = client.post(
        f"/api/v1/projects/{project_id}/searches",
        json={
            "sourceName": "IEEE Xplore",
            "query": "virtual reality",
            "searchDate": "2026-07-30",
            "exportedResultCount": 1,
        },
        headers={"X-CSRF-Token": csrf},
    ).json()
    batch = _make_batch(db, project_id, admin.id, search["id"], tmp_path, "a.csv")
    record = ImportedRecord(
        import_batch_id=batch.id,
        source_row=1,
        raw_data={"title": "Screened paper"},
        parsed_data={"title": "Screened paper"},
        validation_state="valid",
        warnings=[],
    )
    db.add(record)
    db.commit()
    normalize_imported_records(db, batch.id)
    db.commit()

    publication_id = db.scalar(
        select(Publication.id).where(Publication.title == "Screened paper")
    )
    work_item = ScreeningWorkItem(
        project_id=project_id,
        publication_id=publication_id,
        stage="title_abstract",
        slot_number=1,
        assigned_reviewer_id=admin.id,
        random_rank="rank",
        status=WorkItemStatus.SUBMITTED,
    )
    db.add(work_item)
    db.flush()
    db.add(
        ScreeningDecision(
            work_item_id=work_item.id,
            reviewer_id=admin.id,
            outcome=ScreeningOutcome.INCLUDE,
            criteria_answers={},
            version=1,
            is_current=True,
        )
    )
    db.commit()

    preview = client.delete(
        f"/api/v1/projects/{project_id}/searches/{search['id']}",
        headers={"X-CSRF-Token": csrf},
    )
    assert preview.status_code == 200
    preview_body = preview.json()
    assert preview_body["deleted"] is False
    assert preview_body["requiresConfirmation"] is True
    assert preview_body["publicationCount"] == 1
    assert preview_body["screenedPublicationCount"] == 1
    assert preview_body["screenedPublicationTitles"] == ["Screened paper"]

    db.expire_all()
    assert db.get(Publication, publication_id).is_active is True
    assert db.get(SearchSource, search["id"]) is not None

    forced = client.delete(
        f"/api/v1/projects/{project_id}/searches/{search['id']}",
        params={"force": "true"},
        headers={"X-CSRF-Token": csrf},
    )
    assert forced.status_code == 200
    forced_body = forced.json()
    assert forced_body["deleted"] is True
    assert forced_body["publicationCount"] == 1
    assert forced_body["screenedPublicationCount"] == 1

    db.expire_all()
    assert db.get(Publication, publication_id).is_active is False
    assert db.get(SearchSource, search["id"]) is None
