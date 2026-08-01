from io import BytesIO

from openpyxl import Workbook
from sqlalchemy import select

from app.accounts.service import create_user
from app.imports.adapters import parse_bibtex, parse_csv, parse_ris, parse_xlsx
from app.imports.models import ImportBatch, ImportedRecord
from app.jobs.worker import execute_next_job


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
    create_user(db, "admin", "Administrator", "secret-password", is_admin=True)
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
