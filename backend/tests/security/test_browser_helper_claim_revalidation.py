"""A Browser Helper claim is not a standing capability.

Audit finding: every mutable ``/browser-agent/retrieval-jobs/{id}/...``
operation only checked ``job.claimed_by_agent_id == agent.id`` -- the fact
established when the job was claimed. Nothing re-derived whether the agent was
still paired, whether the account behind it was still active, still a project
member, still allowed to do full-text work, whether the batch was still
running, or whether the lease had expired. A helper that claimed one job
before its reviewer was removed from the project could therefore keep
uploading PDFs into that project indefinitely.

These tests drive the real HTTP endpoints, because the whole point of the
finding is that the *service boundary* -- not the extension -- must enforce it.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from io import BytesIO

import pytest
from pypdf import PdfWriter
from sqlalchemy import select

from app.accounts.service import create_user
from app.core.config import get_settings
from app.fulltext.models import (
    FullTextRetrieval,
    PublicationDocument,
    RetrievalStatus,
)
from app.pdf_acquisition.models import (
    BatchStatus,
    BrowserAgent,
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
from tests.security.helpers import login

REVIEWER_PASSWORD = "reviewer-password-value"
MANAGER_PASSWORD = "manager-password-value"


def pdf_bytes() -> bytes:
    stream = BytesIO()
    writer = PdfWriter()
    writer.add_blank_page(width=72, height=72)
    writer.add_metadata({"/Title": "Retrieved paper"})
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
    """A project whose owner manages membership and whose reviewer has
    full-text access and will pair a browser helper."""
    manager = create_user(db, "helper-manager", "Manager", MANAGER_PASSWORD)
    reviewer = create_user(db, "helper-reviewer", "Reviewer", REVIEWER_PASSWORD)
    project = Project(
        name="Browser helper review",
        review_type=ReviewType.SYSTEMATIC_REVIEW,
        random_seed="helper-seed",
        stage=ProjectStage.FULL_TEXT,
    )
    db.add(project)
    db.flush()
    db.add(
        ProjectMembership(
            project_id=project.id,
            user_id=manager.id,
            is_owner=True,
            can_full_text_screen=True,
        )
    )
    membership = ProjectMembership(
        project_id=project.id, user_id=reviewer.id, can_full_text_screen=True
    )
    db.add(membership)
    db.add(
        ScreeningConfig(
            project_id=project.id,
            stage=ScreeningStage.FULL_TEXT,
            required_reviewers=1,
            allocation_mode=AllocationMode.CLAIM,
        )
    )
    publication = Publication(
        project_id=project.id,
        title="Missing PDF",
        doi="10.1/missing",
        publisher_url="https://example.org/paper",
    )
    db.add(publication)
    db.flush()
    db.add(
        FullTextRetrieval(
            project_id=project.id,
            publication_id=publication.id,
            status=RetrievalStatus.NOT_YET_SOUGHT,
        )
    )
    db.commit()
    return manager, reviewer, project, membership, publication


def agent_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def pair_agent(client, csrf: str, *, device_name: str = "Chrome on Desktop") -> str:
    secret = client.post(
        "/api/v1/browser-agents/pairing-secrets", headers={"X-CSRF-Token": csrf}
    ).json()["pairingSecret"]
    paired = client.post(
        "/api/v1/browser-agents/pair",
        json={"pairingSecret": secret, "deviceName": device_name},
    )
    assert paired.status_code == 201
    return str(paired.json()["agentToken"])


def claim_one(client, token: str) -> str:
    response = client.post(
        "/api/v1/browser-agent/retrieval-jobs/claim", headers=agent_headers(token)
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body is not None, "expected a claimable retrieval job"
    return str(body["jobId"])


def upload(client, token: str, job_id: str):
    return client.post(
        f"/api/v1/browser-agent/retrieval-jobs/{job_id}/upload",
        files={"file": ("paper.pdf", pdf_bytes(), "application/pdf")},
        data={
            "sourceUrl": "https://example.org/paper.pdf",
            "landingUrl": "https://example.org/paper",
        },
        headers=agent_headers(token),
    )


def report_state(client, token: str, job_id: str, status: str = "not_found"):
    return client.post(
        f"/api/v1/browser-agent/retrieval-jobs/{job_id}/state",
        json={"status": status},
        headers=agent_headers(token),
    )


def claimed_job(client, db):
    """Common arrangement: batch created, helper paired, one job claimed."""
    manager, reviewer, project, membership, publication = setup_project(db)
    csrf = login(client, reviewer.username, REVIEWER_PASSWORD)
    created = client.post(
        f"/api/v1/projects/{project.id}/pdf-retrieval-batches",
        json={"publicationIds": None},
        headers={"X-CSRF-Token": csrf},
    )
    assert created.status_code == 201, created.text
    token = pair_agent(client, csrf)
    job_id = claim_one(client, token)
    return manager, reviewer, project, membership, publication, token, job_id


# --------------------------------------------------------------------------
# Positive control: nothing below is passing merely because uploads are broken
# --------------------------------------------------------------------------


def test_helper_with_a_live_claim_can_still_upload(client, db) -> None:
    *_rest, publication, token, job_id = claimed_job(client, db)

    response = upload(client, token, job_id)

    assert response.status_code == 200, response.text
    assert response.json()["status"] == "succeeded"
    document = db.scalar(select(PublicationDocument))
    assert document is not None
    assert document.publication_id == publication.id
    retrieval = db.scalar(select(FullTextRetrieval))
    assert retrieval.status == RetrievalStatus.AVAILABLE


def test_helper_with_a_live_claim_can_still_report_a_failure(client, db) -> None:
    *_rest, token, job_id = claimed_job(client, db)

    assert report_state(client, token, job_id, "needs_authentication").status_code == 200


# --------------------------------------------------------------------------
# Revoked reviewer capability / project access
# --------------------------------------------------------------------------


def test_upload_is_rejected_after_full_text_access_is_revoked(client, db) -> None:
    _manager, _reviewer, _project, membership, _pub, token, job_id = claimed_job(
        client, db
    )

    membership.can_full_text_screen = False
    db.commit()

    response = upload(client, token, job_id)

    assert response.status_code == 403
    assert db.scalar(select(PublicationDocument)) is None
    retrieval = db.scalar(select(FullTextRetrieval))
    assert retrieval.status == RetrievalStatus.NOT_YET_SOUGHT


def test_state_update_is_rejected_after_full_text_access_is_revoked(
    client, db
) -> None:
    _manager, _reviewer, _project, membership, _pub, token, job_id = claimed_job(
        client, db
    )

    membership.can_full_text_screen = False
    db.commit()

    assert report_state(client, token, job_id).status_code == 403
    job = db.get(PdfRetrievalJob, job_id)
    assert job.status == RetrievalJobStatus.CLAIMED


def test_mutation_is_rejected_after_the_user_is_removed_from_the_project(
    client, db
) -> None:
    _manager, _reviewer, _project, membership, _pub, token, job_id = claimed_job(
        client, db
    )

    db.delete(membership)
    db.commit()

    assert upload(client, token, job_id).status_code == 403
    assert report_state(client, token, job_id).status_code == 403
    assert db.scalar(select(PublicationDocument)) is None


def test_mutation_is_rejected_after_the_account_is_deactivated(client, db) -> None:
    _manager, reviewer, _project, _membership, _pub, token, job_id = claimed_job(
        client, db
    )

    reviewer.is_active = False
    db.commit()

    # Agent authentication itself already refuses an inactive account; the
    # claim revalidation is the second line of defence behind it.
    assert upload(client, token, job_id).status_code == 403


def test_removing_a_member_releases_their_helper_claims(client, db) -> None:
    """The central membership-change reconciliation is the revocation hook:
    an outstanding claim is requeued promptly rather than sitting until the
    lease expires."""
    manager, _reviewer, project, membership, _pub, token, job_id = claimed_job(
        client, db
    )
    manager_csrf = login(client, manager.username, MANAGER_PASSWORD)

    removed = client.delete(
        f"/api/v1/projects/{project.id}/members/{membership.id}",
        headers={"X-CSRF-Token": manager_csrf},
    )
    assert removed.status_code == 204

    db.expire_all()
    job = db.get(PdfRetrievalJob, job_id)
    assert job.status == RetrievalJobStatus.QUEUED
    assert job.claimed_by_agent_id is None
    assert job.lease_until is None
    assert upload(client, token, job_id).status_code == 403


def test_revoking_the_helper_releases_its_claims(client, db) -> None:
    _manager, reviewer, _project, _membership, _pub, token, job_id = claimed_job(
        client, db
    )
    csrf = login(client, reviewer.username, REVIEWER_PASSWORD)
    agent = db.scalar(select(BrowserAgent))

    revoked = client.delete(
        f"/api/v1/browser-agents/{agent.id}", headers={"X-CSRF-Token": csrf}
    )
    assert revoked.status_code == 204

    db.expire_all()
    job = db.get(PdfRetrievalJob, job_id)
    assert job.status == RetrievalJobStatus.QUEUED
    assert job.claimed_by_agent_id is None
    assert upload(client, token, job_id).status_code == 403


# --------------------------------------------------------------------------
# Expired lease and inactive batch/job
# --------------------------------------------------------------------------


def test_upload_is_rejected_once_the_claim_lease_has_expired(client, db) -> None:
    """Rejected even though nobody has reclaimed the job yet: the lease is
    what bounds the claim, and an expired one is already offered to any other
    eligible helper."""
    *_rest, token, job_id = claimed_job(client, db)

    job = db.get(PdfRetrievalJob, job_id)
    job.lease_until = datetime.now(UTC) - timedelta(seconds=1)
    db.commit()

    response = upload(client, token, job_id)

    assert response.status_code == 409
    assert db.scalar(select(PublicationDocument)) is None
    assert report_state(client, token, job_id).status_code == 409


def test_mutation_is_rejected_once_the_batch_is_cancelled(client, db) -> None:
    _manager, reviewer, project, _membership, _pub, token, job_id = claimed_job(
        client, db
    )
    csrf = login(client, reviewer.username, REVIEWER_PASSWORD)
    batch = db.scalar(select(PdfRetrievalBatch))

    cancelled = client.post(
        f"/api/v1/projects/{project.id}/pdf-retrieval-batches/{batch.id}/cancel",
        headers={"X-CSRF-Token": csrf},
    )
    assert cancelled.status_code == 200

    assert report_state(client, token, job_id).status_code == 409
    assert upload(client, token, job_id).status_code == 409
    assert db.scalar(select(PublicationDocument)) is None
    db.expire_all()
    assert db.scalar(select(PdfRetrievalBatch)).status == BatchStatus.CANCELLED


def test_agent_retry_cannot_resurrect_a_cancelled_batch(client, db) -> None:
    """``retry_failed_jobs`` deliberately reopens a batch -- that is a manager
    action. A helper must not be able to invoke it to undo a cancellation."""
    *_rest, token, job_id = claimed_job(client, db)
    assert report_state(client, token, job_id, "needs_authentication").status_code == 200
    batch = db.scalar(select(PdfRetrievalBatch))
    batch.status = BatchStatus.CANCELLED
    batch.cancelled_at = datetime.now(UTC)
    db.commit()

    response = client.post(
        f"/api/v1/browser-agent/retrieval-jobs/{job_id}/retry",
        headers=agent_headers(token),
    )

    assert response.status_code == 409
    db.expire_all()
    assert db.scalar(select(PdfRetrievalBatch)).status == BatchStatus.CANCELLED


def test_mutation_is_rejected_once_the_job_already_reached_a_terminal_state(
    client, db
) -> None:
    """Guards a second upload replaying onto a job that already finished."""
    *_rest, token, job_id = claimed_job(client, db)
    assert upload(client, token, job_id).status_code == 200

    replay = upload(client, token, job_id)

    assert replay.status_code == 409
    assert len(list(db.scalars(select(PublicationDocument)))) == 1
