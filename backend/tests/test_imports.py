from io import BytesIO

from openpyxl import Workbook
from sqlalchemy import select

from app.accounts.service import create_user
from app.imports.adapters import parse_bibtex, parse_csv, parse_ris, parse_xlsx
from app.imports.models import ImportBatch, ImportedRecord
from app.jobs.worker import execute_next_job


def login(client) -> str:
    response = client.post("/api/v1/auth/login", json={"username": "admin", "password": "secret-password"})
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

    ris_rows = parse_ris(b"TY  - JOUR\nTI  - Paper B\nAU  - Doe, Jane\nDO  - 10.1/b\nER  -\n")
    assert ris_rows[0]["title"] == "Paper B"
    assert ris_rows[0]["authors"] == "Doe, Jane"

    bib_rows = parse_bibtex(b"@article{doe2026, title={Paper C}, author={Doe, Jane}, year={2026}}")
    assert bib_rows[0]["title"] == "Paper C"

    workbook = Workbook()
    sheet = workbook.active
    sheet.append(["Title", "Authors"])
    sheet.append(["Paper D", "Doe"])
    buffer = BytesIO()
    workbook.save(buffer)
    assert parse_xlsx(buffer.getvalue())[0]["Title"] == "Paper D"


def test_csv_import_runs_through_persistent_job(client, db, session_factory, tmp_path, monkeypatch) -> None:
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
        files={"file": ("ieee.csv", b"Document Title,Authors,Abstract,DOI\nPaper A,Doe,Summary,10.1/a\n", "text/csv")},
        headers={"X-CSRF-Token": csrf},
    )
    assert response.status_code == 202
    job_id = response.json()["jobId"]

    assert execute_next_job(session_factory, worker_id="test-worker") is True
    db.expire_all()
    batch = db.scalar(select(ImportBatch).where(ImportBatch.project_id == project_id))
    assert batch is not None
    assert batch.status == "completed"
    records = list(db.scalars(select(ImportedRecord).where(ImportedRecord.import_batch_id == batch.id)))
    assert len(records) == 1
    assert records[0].parsed_data["title"] == "Paper A"

    job = client.get(f"/api/v1/jobs/{job_id}")
    assert job.status_code == 200
    assert job.json()["status"] == "completed"
