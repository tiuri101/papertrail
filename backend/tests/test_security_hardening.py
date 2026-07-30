from pathlib import Path

from app.accounts.service import create_user
from app.core.config import get_settings
from app.jobs.models import BackgroundJob, JobStatus
from app.jobs.service import renew_job_lease
from app.projects.models import Project, ReviewType
from app.reporting.jobs import generate_export_job
from app.reporting.models import ExportArtifact


def login(client, username: str, password: str):
    return client.post(
        "/api/v1/auth/login",
        json={"username": username, "password": password},
    )


def test_security_headers_are_present(client) -> None:
    response = client.get("/health")
    assert response.status_code == 200
    assert response.headers["X-Content-Type-Options"] == "nosniff"
    assert response.headers["X-Frame-Options"] == "DENY"
    assert "frame-ancestors 'none'" in response.headers["Content-Security-Policy"]


def test_login_is_rate_limited_after_repeated_failures(client, db) -> None:
    create_user(db, "reviewer", "Reviewer", "correct-password")
    db.commit()
    settings = get_settings()
    original_attempts = settings.login_max_attempts
    settings.login_max_attempts = 3
    try:
        assert login(client, "reviewer", "wrong-password").status_code == 401
        assert login(client, "reviewer", "wrong-password").status_code == 401
        assert login(client, "reviewer", "wrong-password").status_code == 401
        blocked = login(client, "reviewer", "correct-password")
        assert blocked.status_code == 429
        assert blocked.json()["error"]["code"] == "rate_limited"
    finally:
        settings.login_max_attempts = original_attempts


def test_import_upload_rejects_unsupported_and_oversized_files(client, db) -> None:
    admin = create_user(db, "admin", "Admin", "secret-password", is_admin=True)
    project = Project(name="Secure import", review_type=ReviewType.SYSTEMATIC_REVIEW, random_seed="seed")
    db.add(project)
    db.commit()
    auth = login(client, "admin", "secret-password")
    csrf = auth.json()["csrfToken"]

    unsupported = client.post(
        f"/api/v1/projects/{project.id}/imports",
        files={"file": ("malware.exe", b"x", "application/octet-stream")},
        headers={"X-CSRF-Token": csrf},
    )
    assert unsupported.status_code == 415

    settings = get_settings()
    original_limit = settings.max_upload_bytes
    settings.max_upload_bytes = 4
    try:
        oversized = client.post(
            f"/api/v1/projects/{project.id}/imports",
            files={"file": ("papers.csv", b"12345", "text/csv")},
            headers={"X-CSRF-Token": csrf},
        )
        assert oversized.status_code == 413
    finally:
        settings.max_upload_bytes = original_limit


def test_job_lease_renewal_requires_current_worker(db) -> None:
    job = BackgroundJob(
        job_type="test",
        payload={},
        status=JobStatus.RUNNING,
        locked_by="worker-a",
        attempts=1,
    )
    db.add(job)
    db.commit()
    assert renew_job_lease(db, job.id, "worker-b", 30) is False
    assert renew_job_lease(db, job.id, "worker-a", 30) is True
    assert job.lease_until is not None


def test_export_jobs_are_idempotent(db, tmp_path: Path) -> None:
    admin = create_user(db, "admin", "Admin", "secret-password", is_admin=True)
    project = Project(name="Export", review_type=ReviewType.SYSTEMATIC_REVIEW, random_seed="seed")
    db.add(project)
    db.flush()
    job = BackgroundJob(
        project_id=project.id,
        job_type="generate_export",
        payload={"export_type": "bibtex", "scope": "included"},
        created_by_id=admin.id,
    )
    db.add(job)
    db.commit()

    settings = get_settings()
    original_export_dir = settings.export_dir
    settings.export_dir = tmp_path
    try:
        first = generate_export_job(db, job)
        db.commit()
        second = generate_export_job(db, job)
        db.commit()
    finally:
        settings.export_dir = original_export_dir

    assert first == second
    assert db.query(ExportArtifact).filter_by(job_id=job.id).count() == 1
