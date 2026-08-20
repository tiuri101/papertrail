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


def pdf_bytes(*, title: str = "Test paper") -> bytes:
    stream = BytesIO()
    writer = PdfWriter()
    writer.add_blank_page(width=72, height=72)
    writer.add_metadata({"/Title": title, "/Author": "Doe, Jane"})
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
