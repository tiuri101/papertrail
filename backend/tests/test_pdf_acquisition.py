from __future__ import annotations

import hashlib
from datetime import UTC, datetime, timedelta
from io import BytesIO

import pytest
from pypdf import PdfWriter
from sqlalchemy import select

from app.accounts.service import create_user, hash_token
from app.audit.models import AuditEvent
from app.core.config import get_settings
from app.fulltext.models import (
    FullTextRetrieval,
    PublicationDocument,
    RetrievalStatus,
)
from app.integrations.metadata import LookupOutcome, MetadataLookup
from app.pdf_acquisition.models import (
    BatchStatus,
    BrowserAgent,
    BrowserAgentPairing,
    PdfRetrievalBatch,
    PdfRetrievalJob,
    RetrievalJobStatus,
)
from app.projects.models import (
    AllocationMode,
    Project,
    ProjectMembership,
    ProjectStage,
    ReviewType,
    ScreeningConfig,
    ScreeningStage,
)
from app.publications.models import Publication
from app.screening.models import ScreeningWorkItem


def pdf_bytes(*, title: str = "Test paper", doi: str | None = None) -> bytes:
    stream = BytesIO()
    writer = PdfWriter()
    writer.add_blank_page(width=72, height=72)
    metadata = {"/Title": title, "/Author": "Doe, Jane"}
    if doi:
        metadata["/Subject"] = doi
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


def login(client, username: str, password: str) -> str:
    return client.post(
        "/api/v1/auth/login", json={"username": username, "password": password}
    ).json()["csrfToken"]


def setup_project(db):
    """A project with one full-text reviewer and four publications covering
    the eligibility matrix: missing (eligible), already available, human
    not-found, and never reached full text (title/abstract excluded)."""
    admin = create_user(db, "admin", "Admin", "secret-password", is_admin=True)
    reviewer = create_user(db, "reviewer", "Reviewer", "reviewer-password")
    outsider = create_user(db, "outsider", "Outsider", "outsider-password")
    project = Project(
        name="Review",
        review_type=ReviewType.SYSTEMATIC_REVIEW,
        random_seed="seed",
        stage=ProjectStage.FULL_TEXT,
    )
    db.add(project)
    db.flush()
    db.add(
        ProjectMembership(
            project_id=project.id, user_id=reviewer.id, can_full_text_screen=True
        )
    )
    db.add(
        ScreeningConfig(
            project_id=project.id,
            stage=ScreeningStage.FULL_TEXT,
            required_reviewers=1,
            allocation_mode=AllocationMode.CLAIM,
        )
    )
    pub_missing = Publication(
        project_id=project.id,
        title="Missing PDF",
        doi="10.1/missing",
        publisher_url="https://example.org/paper",
    )
    pub_available = Publication(project_id=project.id, title="Already available")
    pub_notfound = Publication(project_id=project.id, title="Human marked not found")
    pub_excluded = Publication(
        project_id=project.id, title="Excluded at title/abstract"
    )
    db.add_all([pub_missing, pub_available, pub_notfound, pub_excluded])
    db.flush()
    db.add(
        FullTextRetrieval(
            project_id=project.id,
            publication_id=pub_missing.id,
            status=RetrievalStatus.NOT_YET_SOUGHT,
        )
    )
    db.add(
        FullTextRetrieval(
            project_id=project.id,
            publication_id=pub_available.id,
            status=RetrievalStatus.AVAILABLE,
        )
    )
    db.add(
        FullTextRetrieval(
            project_id=project.id,
            publication_id=pub_notfound.id,
            status=RetrievalStatus.NOT_FOUND,
        )
    )
    db.commit()
    return (
        admin,
        reviewer,
        outsider,
        project,
        pub_missing,
        pub_available,
        pub_notfound,
        pub_excluded,
    )


def pair_agent(client, csrf: str, *, device_name: str = "Chrome on Desktop") -> str:
    created = client.post(
        "/api/v1/browser-agents/pairing-secrets", headers={"X-CSRF-Token": csrf}
    )
    assert created.status_code == 200
    secret = created.json()["pairingSecret"]
    paired = client.post(
        "/api/v1/browser-agents/pair",
        json={"pairingSecret": secret, "deviceName": device_name},
    )
    assert paired.status_code == 201
    return paired.json()["agentToken"]


def agent_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


# --- Pairing & agent authentication -------------------------------------------------


def test_pairing_secret_is_hashed_and_shown_once(client, db) -> None:
    _admin, reviewer, _outsider, _project, *_ = setup_project(db)
    csrf = login(client, reviewer.username, "reviewer-password")

    response = client.post(
        "/api/v1/browser-agents/pairing-secrets", headers={"X-CSRF-Token": csrf}
    )
    assert response.status_code == 200
    body = response.json()
    secret = body["pairingSecret"]
    assert "serverUrl" in body and "expiresAt" in body

    row = db.scalar(select(BrowserAgentPairing))
    assert row is not None
    assert row.token_hash == hash_token(secret)
    assert row.token_hash != secret


def test_pairing_secret_expires(client, db) -> None:
    _admin, reviewer, _outsider, _project, *_ = setup_project(db)
    csrf = login(client, reviewer.username, "reviewer-password")
    secret = client.post(
        "/api/v1/browser-agents/pairing-secrets", headers={"X-CSRF-Token": csrf}
    ).json()["pairingSecret"]

    pairing = db.scalar(select(BrowserAgentPairing))
    pairing.expires_at = datetime.now(UTC) - timedelta(minutes=1)
    db.commit()

    paired = client.post(
        "/api/v1/browser-agents/pair",
        json={"pairingSecret": secret, "deviceName": "Chrome"},
    )
    assert paired.status_code == 403


def test_pairing_secret_is_single_use(client, db) -> None:
    _admin, reviewer, _outsider, _project, *_ = setup_project(db)
    csrf = login(client, reviewer.username, "reviewer-password")
    secret = client.post(
        "/api/v1/browser-agents/pairing-secrets", headers={"X-CSRF-Token": csrf}
    ).json()["pairingSecret"]

    first = client.post(
        "/api/v1/browser-agents/pair",
        json={"pairingSecret": secret, "deviceName": "Chrome"},
    )
    assert first.status_code == 201

    second = client.post(
        "/api/v1/browser-agents/pair",
        json={"pairingSecret": secret, "deviceName": "Chrome"},
    )
    assert second.status_code == 403


def test_invalid_pairing_secret_rejected(client, db) -> None:
    setup_project(db)
    response = client.post(
        "/api/v1/browser-agents/pair",
        json={"pairingSecret": "not-a-real-secret", "deviceName": "Chrome"},
    )
    assert response.status_code == 403


def test_raw_agent_token_is_never_persisted(client, db) -> None:
    _admin, reviewer, _outsider, _project, *_ = setup_project(db)
    csrf = login(client, reviewer.username, "reviewer-password")
    token = pair_agent(client, csrf)

    row = db.scalar(select(BrowserAgent))
    assert row is not None
    assert row.token_hash == hash_token(token)
    assert row.token_hash != token


def test_extension_download_requires_login(client, db) -> None:
    setup_project(db)
    response = client.get("/api/v1/browser-agents/extension-download")
    assert response.status_code == 403


def test_extension_download_missing_reports_not_found(client, db, tmp_path) -> None:
    _admin, reviewer, _outsider, _project, *_ = setup_project(db)
    login(client, reviewer.username, "reviewer-password")

    settings = get_settings()
    previous = settings.browser_extension_zip_path
    settings.browser_extension_zip_path = tmp_path / "does-not-exist.zip"
    try:
        response = client.get("/api/v1/browser-agents/extension-download")
        assert response.status_code == 404
    finally:
        settings.browser_extension_zip_path = previous


def test_extension_download_returns_bundled_zip(client, db, tmp_path) -> None:
    _admin, reviewer, _outsider, _project, *_ = setup_project(db)
    login(client, reviewer.username, "reviewer-password")

    zip_path = tmp_path / "papertrail-browser-extension.zip"
    zip_path.write_bytes(b"PK\x03\x04fake-zip-contents")

    settings = get_settings()
    previous = settings.browser_extension_zip_path
    settings.browser_extension_zip_path = zip_path
    try:
        response = client.get("/api/v1/browser-agents/extension-download")
        assert response.status_code == 200
        assert response.headers["content-type"] == "application/zip"
        assert (
            'filename="papertrail-browser-extension.zip"'
            in response.headers["content-disposition"]
        )
        assert response.content == zip_path.read_bytes()
    finally:
        settings.browser_extension_zip_path = previous


def test_valid_agent_token_authenticates(client, db) -> None:
    _admin, reviewer, _outsider, _project, *_ = setup_project(db)
    csrf = login(client, reviewer.username, "reviewer-password")
    token = pair_agent(client, csrf)

    response = client.get("/api/v1/browser-agent/me", headers=agent_headers(token))
    assert response.status_code == 200
    assert response.json()["displayName"] == "Chrome on Desktop"


def test_revoked_agent_token_fails(client, db) -> None:
    _admin, reviewer, _outsider, _project, *_ = setup_project(db)
    csrf = login(client, reviewer.username, "reviewer-password")
    token = pair_agent(client, csrf)
    agent = db.scalar(select(BrowserAgent))

    revoke = client.delete(
        f"/api/v1/browser-agents/{agent.id}", headers={"X-CSRF-Token": csrf}
    )
    assert revoke.status_code == 204

    response = client.get("/api/v1/browser-agent/me", headers=agent_headers(token))
    assert response.status_code == 403


def test_inactive_users_agent_fails(client, db) -> None:
    _admin, reviewer, _outsider, _project, *_ = setup_project(db)
    csrf = login(client, reviewer.username, "reviewer-password")
    token = pair_agent(client, csrf)

    reviewer.is_active = False
    db.commit()

    response = client.get("/api/v1/browser-agent/me", headers=agent_headers(token))
    assert response.status_code == 403


def test_session_cookie_cannot_substitute_for_agent_bearer_auth(client, db) -> None:
    _admin, reviewer, _outsider, _project, *_ = setup_project(db)
    login(client, reviewer.username, "reviewer-password")

    response = client.get("/api/v1/browser-agent/me")
    assert response.status_code == 403


def test_agent_token_cannot_access_unrelated_normal_apis(client, db) -> None:
    _admin, reviewer, _outsider, _project, *_ = setup_project(db)
    csrf = login(client, reviewer.username, "reviewer-password")
    token = pair_agent(client, csrf)
    client.cookies.clear()

    response = client.get("/api/v1/projects", headers=agent_headers(token))
    assert response.status_code == 403


def test_revoking_agent_immediately_prevents_access(client, db) -> None:
    _admin, reviewer, _outsider, _project, *_ = setup_project(db)
    csrf = login(client, reviewer.username, "reviewer-password")
    token = pair_agent(client, csrf)
    agent = db.scalar(select(BrowserAgent))

    client.delete(f"/api/v1/browser-agents/{agent.id}", headers={"X-CSRF-Token": csrf})

    claim = client.post(
        "/api/v1/browser-agent/retrieval-jobs/claim", headers=agent_headers(token)
    )
    assert claim.status_code == 403


# --- Batch creation ------------------------------------------------------------------


def create_batch(client, csrf: str, project_id: str, publication_ids=None):
    return client.post(
        f"/api/v1/projects/{project_id}/pdf-retrieval-batches",
        json={"publicationIds": publication_ids},
        headers={"X-CSRF-Token": csrf},
    )


def test_authorized_full_text_reviewer_can_create_batch(client, db) -> None:
    _admin, reviewer, _outsider, project, pub_missing, *_ = setup_project(db)
    csrf = login(client, reviewer.username, "reviewer-password")

    response = create_batch(client, csrf, project.id)
    assert response.status_code == 201
    body = response.json()
    assert body["batch"]["progress"]["total"] == 1

    job = db.scalar(select(PdfRetrievalJob))
    assert job.publication_id == pub_missing.id
    assert job.status == RetrievalJobStatus.QUEUED


def test_outsider_cannot_create_batch(client, db) -> None:
    _admin, _reviewer, outsider, project, *_ = setup_project(db)
    csrf = login(client, outsider.username, "outsider-password")

    response = create_batch(client, csrf, project.id)
    assert response.status_code == 403


def test_only_eligible_publications_are_included(client, db) -> None:
    (
        _admin,
        reviewer,
        _outsider,
        project,
        pub_missing,
        pub_available,
        pub_notfound,
        pub_excluded,
    ) = setup_project(db)
    csrf = login(client, reviewer.username, "reviewer-password")

    response = create_batch(client, csrf, project.id)
    assert response.status_code == 201

    job_publication_ids = {
        row.publication_id for row in db.scalars(select(PdfRetrievalJob))
    }
    assert job_publication_ids == {pub_missing.id}
    assert pub_available.id not in job_publication_ids
    assert pub_notfound.id not in job_publication_ids
    assert pub_excluded.id not in job_publication_ids


def test_active_pdf_is_skipped_from_eligibility(client, db) -> None:
    _admin, reviewer, _outsider, project, pub_missing, *_ = setup_project(db)
    db.add(
        PublicationDocument(
            project_id=project.id,
            publication_id=pub_missing.id,
            original_filename="already.pdf",
            storage_key="projects/x/y/z.pdf",
            file_size=10,
            sha256="a" * 64,
            is_active=True,
        )
    )
    db.commit()
    csrf = login(client, reviewer.username, "reviewer-password")

    response = create_batch(client, csrf, project.id)
    assert response.status_code == 400


def test_empty_eligible_set_returns_domain_error(client, db) -> None:
    _admin, reviewer, _outsider, project, pub_missing, *_ = setup_project(db)
    retrieval = db.scalar(
        select(FullTextRetrieval).where(
            FullTextRetrieval.publication_id == pub_missing.id
        )
    )
    retrieval.status = RetrievalStatus.NOT_FOUND
    db.commit()
    csrf = login(client, reviewer.username, "reviewer-password")

    response = create_batch(client, csrf, project.id)
    assert response.status_code == 400
    assert "eligible" in response.json()["error"]["message"].lower()


def test_missing_full_text_count_endpoint(client, db) -> None:
    _admin, reviewer, _outsider, project, pub_missing, *_ = setup_project(db)
    csrf = login(client, reviewer.username, "reviewer-password")

    response = client.get(
        f"/api/v1/projects/{project.id}/pdf-retrieval-batches/missing-count",
        headers={"X-CSRF-Token": csrf},
    )
    assert response.status_code == 200
    assert response.json()["missingCount"] == 1


# --- Claiming --------------------------------------------------------------------


def claim(client, token: str):
    return client.post(
        "/api/v1/browser-agent/retrieval-jobs/claim", headers=agent_headers(token)
    )


def test_pending_jobs_count_reflects_claimable_work(client, db) -> None:
    _admin, reviewer, _outsider, project, *_ = setup_project(db)
    csrf = login(client, reviewer.username, "reviewer-password")
    token = pair_agent(client, csrf)

    before = client.get(
        "/api/v1/browser-agent/retrieval-jobs/pending-count",
        headers=agent_headers(token),
    )
    assert before.status_code == 200
    assert before.json()["pendingCount"] == 0

    create_batch(client, csrf, project.id)

    after = client.get(
        "/api/v1/browser-agent/retrieval-jobs/pending-count",
        headers=agent_headers(token),
    )
    assert after.json()["pendingCount"] == 1

    claim(client, token)

    claimed = client.get(
        "/api/v1/browser-agent/retrieval-jobs/pending-count",
        headers=agent_headers(token),
    )
    assert claimed.json()["pendingCount"] == 0


def test_pending_jobs_count_requires_agent_auth(client, db) -> None:
    setup_project(db)
    response = client.get("/api/v1/browser-agent/retrieval-jobs/pending-count")
    assert response.status_code == 403


def test_claim_persists_lease_and_attempt_count(client, db) -> None:
    _admin, reviewer, _outsider, project, *_ = setup_project(db)
    csrf = login(client, reviewer.username, "reviewer-password")
    create_batch(client, csrf, project.id)
    token = pair_agent(client, csrf)

    response = claim(client, token)
    assert response.status_code == 200
    body = response.json()
    assert body["publication"]["title"] == "Missing PDF"
    assert body["maxPdfBytes"] == get_settings().max_pdf_size_mb * 1024 * 1024

    job = db.scalar(select(PdfRetrievalJob))
    assert job.status == RetrievalJobStatus.CLAIMED
    assert job.claimed_by_agent_id is not None
    assert job.claimed_at is not None
    assert job.lease_until is not None
    assert job.attempt_count == 1


def test_expired_claim_can_be_reclaimed(client, db) -> None:
    _admin, reviewer, _outsider, project, *_ = setup_project(db)
    csrf = login(client, reviewer.username, "reviewer-password")
    create_batch(client, csrf, project.id)
    token = pair_agent(client, csrf)
    claim(client, token)

    job = db.scalar(select(PdfRetrievalJob))
    job.lease_until = datetime.now(UTC) - timedelta(seconds=1)
    db.commit()

    second_token = pair_agent(client, csrf, device_name="Chrome on Laptop")
    response = claim(client, second_token)
    assert response.status_code == 200
    assert response.json()["jobId"] == job.id

    db.refresh(job)
    assert job.attempt_count == 2


def test_active_claim_cannot_be_stolen(client, db) -> None:
    _admin, reviewer, _outsider, project, *_ = setup_project(db)
    csrf = login(client, reviewer.username, "reviewer-password")
    create_batch(client, csrf, project.id)
    token = pair_agent(client, csrf)
    second_token = pair_agent(client, csrf, device_name="Chrome on Laptop")

    first = claim(client, token)
    assert first.json() is not None

    second = claim(client, second_token)
    assert second.json() is None


def test_agent_cannot_claim_another_users_batch(client, db) -> None:
    _admin, reviewer, outsider, project, *_ = setup_project(db)
    csrf = login(client, reviewer.username, "reviewer-password")
    create_batch(client, csrf, project.id)

    outsider_csrf = login(client, outsider.username, "outsider-password")
    outsider_token = pair_agent(client, outsider_csrf, device_name="Outsider Chrome")

    response = claim(client, outsider_token)
    assert response.status_code == 200
    assert response.json() is None


def test_removed_project_access_prevents_claim(client, db) -> None:
    _admin, reviewer, _outsider, project, *_ = setup_project(db)
    csrf = login(client, reviewer.username, "reviewer-password")
    create_batch(client, csrf, project.id)
    token = pair_agent(client, csrf)

    membership = db.scalar(
        select(ProjectMembership).where(
            ProjectMembership.project_id == project.id,
            ProjectMembership.user_id == reviewer.id,
        )
    )
    membership.can_full_text_screen = False
    db.commit()

    response = claim(client, token)
    assert response.status_code == 200
    assert response.json() is None

    job = db.scalar(select(PdfRetrievalJob))
    assert job.status == RetrievalJobStatus.QUEUED


def test_cancelled_batch_cannot_be_claimed(client, db) -> None:
    _admin, reviewer, _outsider, project, *_ = setup_project(db)
    csrf = login(client, reviewer.username, "reviewer-password")
    batch_id = create_batch(client, csrf, project.id).json()["batch"]["id"]
    token = pair_agent(client, csrf)

    cancel = client.post(
        f"/api/v1/projects/{project.id}/pdf-retrieval-batches/{batch_id}/cancel",
        headers={"X-CSRF-Token": csrf},
    )
    assert cancel.status_code == 200

    response = claim(client, token)
    assert response.json() is None


# --- State transitions ----------------------------------------------------------


def test_valid_transition_succeeds(client, db) -> None:
    _admin, reviewer, _outsider, project, *_ = setup_project(db)
    csrf = login(client, reviewer.username, "reviewer-password")
    create_batch(client, csrf, project.id)
    token = pair_agent(client, csrf)
    job_id = claim(client, token).json()["jobId"]

    response = client.post(
        f"/api/v1/browser-agent/retrieval-jobs/{job_id}/state",
        json={"status": "needs_authentication", "httpStatus": 200},
        headers=agent_headers(token),
    )
    assert response.status_code == 200
    assert response.json()["status"] == "needs_authentication"


def test_invalid_transition_fails(client, db) -> None:
    _admin, reviewer, _outsider, project, *_ = setup_project(db)
    csrf = login(client, reviewer.username, "reviewer-password")
    create_batch(client, csrf, project.id)
    token = pair_agent(client, csrf)
    job_id = claim(client, token).json()["jobId"]

    response = client.post(
        f"/api/v1/browser-agent/retrieval-jobs/{job_id}/state",
        json={"status": "succeeded"},
        headers=agent_headers(token),
    )
    assert response.status_code == 409


def test_wrong_agent_cannot_update_job(client, db) -> None:
    _admin, reviewer, _outsider, project, *_ = setup_project(db)
    csrf = login(client, reviewer.username, "reviewer-password")
    create_batch(client, csrf, project.id)
    token = pair_agent(client, csrf)
    other_token = pair_agent(client, csrf, device_name="Other Chrome")
    job_id = claim(client, token).json()["jobId"]

    response = client.post(
        f"/api/v1/browser-agent/retrieval-jobs/{job_id}/state",
        json={"status": "not_found"},
        headers=agent_headers(other_token),
    )
    assert response.status_code == 403


def test_expired_claimant_loses_update_rights_after_reclaim(client, db) -> None:
    _admin, reviewer, _outsider, project, *_ = setup_project(db)
    csrf = login(client, reviewer.username, "reviewer-password")
    create_batch(client, csrf, project.id)
    token = pair_agent(client, csrf)
    job_id = claim(client, token).json()["jobId"]

    job = db.get(PdfRetrievalJob, job_id)
    job.lease_until = datetime.now(UTC) - timedelta(seconds=1)
    db.commit()

    second_token = pair_agent(client, csrf, device_name="Chrome on Laptop")
    reclaimed = claim(client, second_token)
    assert reclaimed.json()["jobId"] == job_id

    stale_update = client.post(
        f"/api/v1/browser-agent/retrieval-jobs/{job_id}/state",
        json={"status": "not_found"},
        headers=agent_headers(token),
    )
    assert stale_update.status_code == 403


def test_error_message_length_is_limited(client, db) -> None:
    _admin, reviewer, _outsider, project, *_ = setup_project(db)
    csrf = login(client, reviewer.username, "reviewer-password")
    create_batch(client, csrf, project.id)
    token = pair_agent(client, csrf)
    job_id = claim(client, token).json()["jobId"]

    long_message = "x" * 5000
    response = client.post(
        f"/api/v1/browser-agent/retrieval-jobs/{job_id}/state",
        json={"status": "failed", "errorMessage": long_message},
        headers=agent_headers(token),
    )
    assert response.status_code == 200
    job = db.get(PdfRetrievalJob, job_id)
    assert len(job.error_message) <= 500


@pytest.mark.parametrize(
    "failure_status",
    [
        "needs_authentication",
        "not_found",
        "access_denied",
        "invalid_response",
        "failed",
    ],
)
def test_automated_failure_never_changes_human_retrieval_status(
    client, db, failure_status
) -> None:
    _admin, reviewer, _outsider, project, pub_missing, *_ = setup_project(db)
    csrf = login(client, reviewer.username, "reviewer-password")
    create_batch(client, csrf, project.id)
    token = pair_agent(client, csrf)
    job_id = claim(client, token).json()["jobId"]

    response = client.post(
        f"/api/v1/browser-agent/retrieval-jobs/{job_id}/state",
        json={"status": failure_status},
        headers=agent_headers(token),
    )
    assert response.status_code == 200

    retrieval = db.scalar(
        select(FullTextRetrieval).where(
            FullTextRetrieval.publication_id == pub_missing.id
        )
    )
    assert retrieval.status == RetrievalStatus.NOT_YET_SOUGHT


# --- Upload ------------------------------------------------------------------------


def upload(client, token: str, job_id: str, content: bytes, filename="paper.pdf"):
    return client.post(
        f"/api/v1/browser-agent/retrieval-jobs/{job_id}/upload",
        files={"file": (filename, content, "application/pdf")},
        data={
            "sourceUrl": "https://example.org/paper.pdf",
            "landingUrl": "https://example.org/paper",
        },
        headers=agent_headers(token),
    )


def test_successful_upload_creates_document_and_marks_available(client, db) -> None:
    _admin, reviewer, _outsider, project, pub_missing, *_ = setup_project(db)
    csrf = login(client, reviewer.username, "reviewer-password")
    create_batch(client, csrf, project.id)
    token = pair_agent(client, csrf)
    job_id = claim(client, token).json()["jobId"]

    content = pdf_bytes()
    response = upload(client, token, job_id, content)
    assert response.status_code == 200
    assert response.json()["status"] == "succeeded"

    document = db.scalar(select(PublicationDocument))
    assert document is not None
    assert document.source.value == "browser_retrieval"
    assert document.sha256 == hashlib.sha256(content).hexdigest()
    assert document.uploaded_by_user_id == reviewer.id

    job = db.get(PdfRetrievalJob, job_id)
    assert job.created_document_id == document.id
    assert job.status == RetrievalJobStatus.SUCCEEDED

    retrieval = db.scalar(
        select(FullTextRetrieval).where(
            FullTextRetrieval.publication_id == pub_missing.id
        )
    )
    assert retrieval.status == RetrievalStatus.AVAILABLE

    work_item = db.scalar(
        select(ScreeningWorkItem).where(
            ScreeningWorkItem.publication_id == pub_missing.id,
            ScreeningWorkItem.stage == ScreeningStage.FULL_TEXT,
        )
    )
    assert work_item is not None

    audit = db.scalar(
        select(AuditEvent).where(AuditEvent.action == "pdf_retrieval.job_succeeded")
    )
    assert audit is not None
    assert audit.event_metadata["retrievalJobId"] == job_id

    batch = db.scalar(select(PdfRetrievalBatch))
    assert batch.status == BatchStatus.COMPLETED


def test_invalid_pdf_is_rejected(client, db) -> None:
    _admin, reviewer, _outsider, project, *_ = setup_project(db)
    csrf = login(client, reviewer.username, "reviewer-password")
    create_batch(client, csrf, project.id)
    token = pair_agent(client, csrf)
    job_id = claim(client, token).json()["jobId"]

    response = upload(
        client, token, job_id, b"<html><body>please sign in</body></html>"
    )
    assert response.status_code == 415

    # The rejected upload is not committed, so the job keeps its live claim
    # (rather than being silently marked "uploading" forever) and the
    # extension can report a terminal status via /state or simply retry.
    job = db.get(PdfRetrievalJob, job_id)
    assert job.status == RetrievalJobStatus.CLAIMED
    assert db.scalar(select(PublicationDocument)) is None


def test_oversized_pdf_is_rejected(client, db) -> None:
    _admin, reviewer, _outsider, project, *_ = setup_project(db)
    settings = get_settings()
    previous_limit = settings.max_pdf_size_mb
    settings.max_pdf_size_mb = 0
    try:
        csrf = login(client, reviewer.username, "reviewer-password")
        create_batch(client, csrf, project.id)
        token = pair_agent(client, csrf)
        job_id = claim(client, token).json()["jobId"]

        response = upload(client, token, job_id, pdf_bytes())
        assert response.status_code == 413
    finally:
        settings.max_pdf_size_mb = previous_limit


def test_existing_active_pdf_is_not_replaced(client, db) -> None:
    _admin, reviewer, _outsider, project, pub_missing, *_ = setup_project(db)
    csrf = login(client, reviewer.username, "reviewer-password")
    create_batch(client, csrf, project.id)
    token = pair_agent(client, csrf)
    job_id = claim(client, token).json()["jobId"]

    manual_upload = client.post(
        f"/api/v1/projects/{project.id}/publications/{pub_missing.id}/full-text",
        files={"file": ("manual.pdf", pdf_bytes(title="Manual"), "application/pdf")},
        headers={"X-CSRF-Token": csrf},
    )
    assert manual_upload.status_code == 201
    manual_document_id = manual_upload.json()["document"]["id"]

    response = upload(client, token, job_id, pdf_bytes(title="Browser"))
    assert response.status_code == 200
    assert response.json()["status"] == "skipped_existing"

    active_document = db.scalar(
        select(PublicationDocument).where(PublicationDocument.is_active.is_(True))
    )
    assert active_document.id == manual_document_id
    updated_job = db.scalar(select(PdfRetrievalJob).where(PdfRetrievalJob.id == job_id))
    assert updated_job.status == RetrievalJobStatus.SKIPPED_EXISTING


# --- Batch behavior --------------------------------------------------------------


def test_batch_completes_when_all_jobs_terminal(client, db) -> None:
    _admin, reviewer, _outsider, project, *_ = setup_project(db)
    csrf = login(client, reviewer.username, "reviewer-password")
    batch_id = create_batch(client, csrf, project.id).json()["batch"]["id"]
    token = pair_agent(client, csrf)
    job_id = claim(client, token).json()["jobId"]

    client.post(
        f"/api/v1/browser-agent/retrieval-jobs/{job_id}/state",
        json={"status": "not_found"},
        headers=agent_headers(token),
    )

    batch = db.get(PdfRetrievalBatch, batch_id)
    assert batch.status == BatchStatus.COMPLETED
    assert batch.completed_at is not None


def test_cancel_terminates_open_jobs_but_keeps_succeeded_documents(client, db) -> None:
    _admin, reviewer, _outsider, project, pub_missing, *_ = setup_project(db)
    other_pub = Publication(project_id=project.id, title="Second missing paper")
    db.add(other_pub)
    db.flush()
    db.add(
        FullTextRetrieval(
            project_id=project.id,
            publication_id=other_pub.id,
            status=RetrievalStatus.NOT_YET_SOUGHT,
        )
    )
    db.commit()

    csrf = login(client, reviewer.username, "reviewer-password")
    batch_id = create_batch(client, csrf, project.id).json()["batch"]["id"]
    token = pair_agent(client, csrf)

    first_claim = claim(client, token).json()
    upload(client, token, first_claim["jobId"], pdf_bytes())

    cancel = client.post(
        f"/api/v1/projects/{project.id}/pdf-retrieval-batches/{batch_id}/cancel",
        headers={"X-CSRF-Token": csrf},
    )
    assert cancel.status_code == 200

    jobs = list(
        db.scalars(select(PdfRetrievalJob).where(PdfRetrievalJob.batch_id == batch_id))
    )
    statuses = {job.publication_id: job.status for job in jobs}
    assert statuses[first_claim["publication"]["id"]] == RetrievalJobStatus.SUCCEEDED
    assert statuses[other_pub.id] == RetrievalJobStatus.CANCELLED
    assert db.scalar(select(PublicationDocument)) is not None


def test_retry_resets_retryable_jobs_and_reopens_batch(client, db) -> None:
    _admin, reviewer, _outsider, project, *_ = setup_project(db)
    csrf = login(client, reviewer.username, "reviewer-password")
    batch_id = create_batch(client, csrf, project.id).json()["batch"]["id"]
    token = pair_agent(client, csrf)
    job_id = claim(client, token).json()["jobId"]

    client.post(
        f"/api/v1/browser-agent/retrieval-jobs/{job_id}/state",
        json={"status": "not_found"},
        headers=agent_headers(token),
    )
    batch = db.get(PdfRetrievalBatch, batch_id)
    assert batch.status == BatchStatus.COMPLETED

    retry = client.post(
        f"/api/v1/projects/{project.id}/pdf-retrieval-batches/{batch_id}/retry-failed",
        headers={"X-CSRF-Token": csrf},
    )
    assert retry.status_code == 200

    db.refresh(batch)
    assert batch.status == BatchStatus.RUNNING
    job = db.get(PdfRetrievalJob, job_id)
    assert job.status == RetrievalJobStatus.QUEUED
    assert job.claimed_by_agent_id is None
    assert job.error_code is None


# --- Manual capture (ad-hoc tab capture, no PdfRetrievalJob) ------------------------


def detect(client, token: str, project_id: str, content: bytes, filename="paper.pdf"):
    return client.post(
        "/api/v1/browser-agent/pdf-captures/detect",
        files={"file": (filename, content, "application/pdf")},
        data={"project_id": project_id},
        headers=agent_headers(token),
    )


def capture_upload(
    client, token: str, publication_id: str, content: bytes, *, replace: bool = False
):
    return client.post(
        f"/api/v1/browser-agent/publications/{publication_id}/pdf-captures",
        files={"file": ("paper.pdf", content, "application/pdf")},
        data={"replace": "true" if replace else "false"},
        headers=agent_headers(token),
    )


def test_agent_projects_lists_only_projects_with_full_text_access(client, db) -> None:
    _admin, reviewer, outsider, project, *_ = setup_project(db)
    csrf = login(client, reviewer.username, "reviewer-password")
    token = pair_agent(client, csrf)

    response = client.get("/api/v1/browser-agent/projects", headers=agent_headers(token))
    assert response.status_code == 200
    assert [p["id"] for p in response.json()] == [project.id]

    outsider_csrf = login(client, outsider.username, "outsider-password")
    outsider_token = pair_agent(client, outsider_csrf, device_name="Outsider Chrome")
    outsider_response = client.get(
        "/api/v1/browser-agent/projects", headers=agent_headers(outsider_token)
    )
    assert outsider_response.json() == []


def test_agent_publication_search_finds_by_title(client, db) -> None:
    _admin, reviewer, _outsider, project, pub_missing, *_ = setup_project(db)
    csrf = login(client, reviewer.username, "reviewer-password")
    token = pair_agent(client, csrf)

    response = client.get(
        f"/api/v1/browser-agent/projects/{project.id}/publications/search",
        params={"q": "Missing PDF"},
        headers=agent_headers(token),
    )
    assert response.status_code == 200
    ids = [row["id"] for row in response.json()]
    assert ids == [pub_missing.id]


def test_agent_publication_search_requires_full_text_access(client, db) -> None:
    _admin, _reviewer, outsider, project, *_ = setup_project(db)
    csrf = login(client, outsider.username, "outsider-password")
    token = pair_agent(client, csrf)

    response = client.get(
        f"/api/v1/browser-agent/projects/{project.id}/publications/search",
        params={"q": "Missing"},
        headers=agent_headers(token),
    )
    assert response.status_code == 403


def test_detect_auto_matches_exact_doi(client, db) -> None:
    _admin, reviewer, _outsider, project, pub_missing, *_ = setup_project(db)
    pub_missing.doi = "10.1234/exact-match"
    db.commit()
    csrf = login(client, reviewer.username, "reviewer-password")
    token = pair_agent(client, csrf)

    content = pdf_bytes(doi="10.1234/exact-match")
    response = detect(client, token, project.id, content)
    assert response.status_code == 200
    body = response.json()
    assert body["detectedDoi"] == "10.1234/exact-match"
    assert body["ambiguous"] is False
    assert body["match"]["id"] == pub_missing.id


def test_detect_reports_ambiguous_doi_without_a_match(client, db) -> None:
    _admin, reviewer, _outsider, project, pub_missing, pub_available, *_ = (
        setup_project(db)
    )
    pub_missing.doi = "10.1234/shared"
    pub_available.doi = "10.1234/shared"
    db.commit()
    csrf = login(client, reviewer.username, "reviewer-password")
    token = pair_agent(client, csrf)

    response = detect(client, token, project.id, pdf_bytes(doi="10.1234/shared"))
    assert response.status_code == 200
    body = response.json()
    assert body["ambiguous"] is True
    assert body["match"] is None


def test_detect_with_no_doi_returns_no_match(client, db) -> None:
    _admin, reviewer, _outsider, project, *_ = setup_project(db)
    csrf = login(client, reviewer.username, "reviewer-password")
    token = pair_agent(client, csrf)

    response = detect(client, token, project.id, pdf_bytes())
    assert response.status_code == 200
    body = response.json()
    assert body["detectedDoi"] is None
    assert body["match"] is None
    assert body["ambiguous"] is False


def test_detect_does_not_write_to_disk(client, db, tmp_path) -> None:
    _admin, reviewer, _outsider, project, *_ = setup_project(db)
    csrf = login(client, reviewer.username, "reviewer-password")
    token = pair_agent(client, csrf)

    detect(client, token, project.id, pdf_bytes(doi="10.1234/exact-match"))

    staging_root = get_settings().pdf_storage_path / "staging"
    written_files = list(staging_root.rglob("*.pdf")) if staging_root.exists() else []
    assert written_files == []


def test_detect_requires_full_text_access(client, db) -> None:
    _admin, _reviewer, outsider, project, *_ = setup_project(db)
    csrf = login(client, outsider.username, "outsider-password")
    token = pair_agent(client, csrf)

    response = detect(client, token, project.id, pdf_bytes())
    assert response.status_code == 403


def test_capture_upload_attaches_pdf_and_marks_available(client, db) -> None:
    _admin, reviewer, _outsider, project, pub_missing, *_ = setup_project(db)
    csrf = login(client, reviewer.username, "reviewer-password")
    token = pair_agent(client, csrf)

    content = pdf_bytes()
    response = capture_upload(client, token, pub_missing.id, content)
    assert response.status_code == 200
    body = response.json()
    assert body["publicationId"] == pub_missing.id

    document = db.scalar(select(PublicationDocument))
    assert document is not None
    assert document.source.value == "browser_manual_capture"
    assert document.sha256 == hashlib.sha256(content).hexdigest()
    assert document.uploaded_by_user_id == reviewer.id
    assert document.is_active is True

    retrieval = db.scalar(
        select(FullTextRetrieval).where(
            FullTextRetrieval.publication_id == pub_missing.id
        )
    )
    assert retrieval.status == RetrievalStatus.AVAILABLE

    audit = db.scalar(
        select(AuditEvent).where(AuditEvent.action == "pdf.captured_browser_manual")
    )
    assert audit is not None
    assert audit.event_metadata["publicationId"] == pub_missing.id


def test_capture_upload_conflicts_without_replace(client, db) -> None:
    _admin, reviewer, _outsider, project, pub_missing, *_ = setup_project(db)
    csrf = login(client, reviewer.username, "reviewer-password")
    token = pair_agent(client, csrf)

    manual_upload = client.post(
        f"/api/v1/projects/{project.id}/publications/{pub_missing.id}/full-text",
        files={"file": ("manual.pdf", pdf_bytes(title="Manual"), "application/pdf")},
        headers={"X-CSRF-Token": csrf},
    )
    assert manual_upload.status_code == 201
    manual_document_id = manual_upload.json()["document"]["id"]

    response = capture_upload(
        client, token, pub_missing.id, pdf_bytes(title="Captured")
    )
    assert response.status_code == 409

    active_document = db.scalar(
        select(PublicationDocument).where(PublicationDocument.is_active.is_(True))
    )
    assert active_document.id == manual_document_id


def test_capture_upload_replaces_existing_pdf_when_asked(client, db) -> None:
    _admin, reviewer, _outsider, project, pub_missing, *_ = setup_project(db)
    csrf = login(client, reviewer.username, "reviewer-password")
    token = pair_agent(client, csrf)

    manual_upload = client.post(
        f"/api/v1/projects/{project.id}/publications/{pub_missing.id}/full-text",
        files={"file": ("manual.pdf", pdf_bytes(title="Manual"), "application/pdf")},
        headers={"X-CSRF-Token": csrf},
    )
    manual_document_id = manual_upload.json()["document"]["id"]

    response = capture_upload(
        client, token, pub_missing.id, pdf_bytes(title="Captured"), replace=True
    )
    assert response.status_code == 200

    old_document = db.get(PublicationDocument, manual_document_id)
    assert old_document.is_active is False
    assert old_document.replaced_by_document_id is not None

    new_document = db.scalar(
        select(PublicationDocument).where(PublicationDocument.is_active.is_(True))
    )
    assert new_document.id == old_document.replaced_by_document_id
    assert new_document.source.value == "browser_manual_capture"


def test_capture_upload_requires_full_text_access(client, db) -> None:
    _admin, _reviewer, outsider, project, pub_missing, *_ = setup_project(db)
    csrf = login(client, outsider.username, "outsider-password")
    token = pair_agent(client, csrf)

    response = capture_upload(client, token, pub_missing.id, pdf_bytes())
    assert response.status_code == 403
    assert db.scalar(select(PublicationDocument)) is None


def test_agent_token_still_cannot_reach_session_only_publication_endpoints(
    client, db
) -> None:
    """Regression guard for the invariant documented on
    get_current_browser_agent: a BrowserAgent bearer token must never
    authenticate any endpoint outside app.pdf_acquisition's agent_router,
    including the new manual-capture surface's neighbors."""
    _admin, reviewer, _outsider, project, *_ = setup_project(db)
    csrf = login(client, reviewer.username, "reviewer-password")
    token = pair_agent(client, csrf)
    client.cookies.clear()

    response = client.get(
        f"/api/v1/projects/{project.id}/publications", headers=agent_headers(token)
    )
    assert response.status_code == 403


# --- Manual capture: create-publication-on-the-spot ---------------------------------


def create_agent_publication(client, token: str, project_id: str, **fields):
    return client.post(
        f"/api/v1/browser-agent/projects/{project_id}/publications",
        json=fields,
        headers=agent_headers(token),
    )


def test_create_agent_publication_creates_and_enrolls_in_screening(client, db) -> None:
    _admin, reviewer, _outsider, project, *_ = setup_project(db)
    membership = db.scalar(
        select(ProjectMembership).where(
            ProjectMembership.project_id == project.id,
            ProjectMembership.user_id == reviewer.id,
        )
    )
    membership.can_title_abstract_screen = True
    db.add(
        ScreeningConfig(
            project_id=project.id,
            stage=ScreeningStage.TITLE_ABSTRACT,
            required_reviewers=1,
            allocation_mode=AllocationMode.CLAIM,
        )
    )
    db.commit()
    csrf = login(client, reviewer.username, "reviewer-password")
    token = pair_agent(client, csrf)

    response = create_agent_publication(
        client,
        token,
        project.id,
        title="A Freshly Captured Paper",
        authors="Doe, Jane and Smith, John",
        publicationYear=2026,
        doi="https://doi.org/10.9999/Fresh.Paper",
    )
    assert response.status_code == 201
    body = response.json()
    assert body["title"] == "A Freshly Captured Paper"
    assert body["doi"] == "10.9999/fresh.paper"

    publication = db.get(Publication, body["id"])
    assert publication is not None
    assert publication.project_id == project.id
    assert publication.authors == "Doe, Jane and Smith, John"
    assert publication.publication_year == 2026

    work_item = db.scalar(
        select(ScreeningWorkItem).where(
            ScreeningWorkItem.publication_id == publication.id,
            ScreeningWorkItem.stage == ScreeningStage.TITLE_ABSTRACT,
        )
    )
    assert work_item is not None

    audit = db.scalar(
        select(AuditEvent).where(
            AuditEvent.action == "publication.created_browser_capture"
        )
    )
    assert audit is not None
    assert audit.entity_id == publication.id
    assert audit.actor_id == reviewer.id


def test_create_agent_publication_overwrites_with_provider_metadata(
    client, db, monkeypatch
) -> None:
    """Unique to this endpoint: when a DOI is present, an authoritative
    provider record overwrites whatever the reviewer typed -- see
    app.publications.service.overwrite_values_from_providers."""
    class StubProvider:
        name = "crossref"

        def lookup_doi(self, doi: str) -> MetadataLookup:
            return MetadataLookup(
                LookupOutcome.FOUND,
                data={
                    "title": "Authoritative Title From Crossref",
                    "authors": "Doe, Jane",
                    "publication_year": 2024,
                },
            )

    monkeypatch.setattr(
        "app.publications.service.metadata_providers", lambda: [StubProvider()]
    )
    _admin, reviewer, _outsider, project, *_ = setup_project(db)
    csrf = login(client, reviewer.username, "reviewer-password")
    token = pair_agent(client, csrf)

    response = create_agent_publication(
        client,
        token,
        project.id,
        title="Whatever The Reviewer Typed",
        doi="10.1234/known",
    )
    assert response.status_code == 201
    body = response.json()
    assert body["title"] == "Authoritative Title From Crossref"

    publication = db.get(Publication, body["id"])
    assert publication.authors == "Doe, Jane"
    assert publication.publication_year == 2024


def test_create_agent_publication_accepts_title_only(client, db) -> None:
    _admin, reviewer, _outsider, project, *_ = setup_project(db)
    csrf = login(client, reviewer.username, "reviewer-password")
    token = pair_agent(client, csrf)

    response = create_agent_publication(client, token, project.id, title="Bare Minimum")
    assert response.status_code == 201
    assert response.json()["title"] == "Bare Minimum"


def test_create_agent_publication_requires_full_text_access(client, db) -> None:
    _admin, _reviewer, outsider, project, *_ = setup_project(db)
    csrf = login(client, outsider.username, "outsider-password")
    token = pair_agent(client, csrf)

    response = create_agent_publication(client, token, project.id, title="Should Fail")
    assert response.status_code == 403
    assert db.scalar(select(Publication).where(Publication.title == "Should Fail")) is None


def test_create_then_attach_captured_pdf_to_new_publication(client, db) -> None:
    """The end-to-end flow the extension drives when a capture doesn't match
    any existing publication: create one on the spot, then attach the same
    captured PDF to it."""
    _admin, reviewer, _outsider, project, *_ = setup_project(db)
    csrf = login(client, reviewer.username, "reviewer-password")
    token = pair_agent(client, csrf)

    created = create_agent_publication(
        client, token, project.id, title="Newly Captured Paper"
    )
    publication_id = created.json()["id"]

    content = pdf_bytes()
    response = capture_upload(client, token, publication_id, content)
    assert response.status_code == 200

    document = db.scalar(select(PublicationDocument))
    assert document is not None
    assert document.publication_id == publication_id
    assert document.source.value == "browser_manual_capture"

    # A freshly created publication has no FullTextRetrieval row yet (that
    # only appears once it's included at title/abstract screening and the
    # project reaches full-text stage) -- the attached document just waits
    # for the workflow to catch up to it, rather than forcing one into being.
    assert (
        db.scalar(
            select(FullTextRetrieval).where(
                FullTextRetrieval.publication_id == publication_id
            )
        )
        is None
    )
