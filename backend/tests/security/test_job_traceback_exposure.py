"""A failed background job's traceback must never reach an ordinary member.

The worker records ``traceback.format_exc()`` so an administrator can debug a
failure. That text carries stack frames, deployment filesystem paths, raw
exception reprs and (for a database error) the SQL statement with its bound
parameters. Ordinary job endpoints -- ``GET /jobs/{id}`` and
``GET /projects/{id}/jobs`` -- returned ``job.result`` wholesale, handing all
of it to every project member.

Each test below drives a real failing job through ``execute_next_job`` with a
distinctive marker embedded in the exception, then asserts where that marker
is allowed to appear.
"""

from __future__ import annotations

from app.accounts.service import create_user
from app.jobs.models import BackgroundJob, JobStatus
from app.jobs.sanitize import public_error_message, public_job_result
from app.jobs.service import enqueue_job
from app.jobs.worker import HANDLERS, execute_next_job
from app.projects.models import Project, ProjectMembership, ReviewType
from tests.security.helpers import login

# A string that only ever exists inside the traceback/diagnostic text, so any
# appearance of it in a response body is unambiguously a leak.
TRACEBACK_MARKER = "papertrail-secret-frame-marker"
FAILURE_MESSAGE = (
    f"Connection to db-internal.papertrail.local failed while reading "
    f"/srv/papertrail/data/pdfs/{TRACEBACK_MARKER}.pdf "
    f"[SQL: SELECT users.password_hash FROM users]"
)

MEMBER_PASSWORD = "member-password-value"
MANAGER_PASSWORD = "manager-password-value"
ADMIN_PASSWORD = "admin-password-value"


def _failing_handler(db, job):  # noqa: ANN001 - test double matching Handler
    def papertrail_secret_frame_marker() -> None:
        raise RuntimeError(FAILURE_MESSAGE)

    papertrail_secret_frame_marker()


def _build_failed_job(client, db, session_factory, monkeypatch, *, with_project=True):
    """Create a project with a member, an owner and an admin, then run one
    background job to a real FAILED state."""
    admin = create_user(db, "job-admin", "Admin", ADMIN_PASSWORD, is_admin=True)
    manager = create_user(db, "job-manager", "Manager", MANAGER_PASSWORD)
    member = create_user(db, "job-member", "Member", MEMBER_PASSWORD)
    project_id = None
    if with_project:
        project = Project(
            name="Traceback review",
            review_type=ReviewType.SYSTEMATIC_REVIEW,
            random_seed="traceback-seed",
        )
        db.add(project)
        db.flush()
        db.add(
            ProjectMembership(
                project_id=project.id, user_id=manager.id, is_owner=True
            )
        )
        db.add(ProjectMembership(project_id=project.id, user_id=member.id))
        project_id = project.id
    job = enqueue_job(
        db,
        "generate_export",
        {"export_type": "xlsx", "scope": "included"},
        project_id=project_id,
        created_by_id=member.id,
        max_attempts=1,
    )
    job_id = job.id
    db.commit()

    monkeypatch.setitem(HANDLERS, "generate_export", _failing_handler)
    assert execute_next_job(session_factory, "test-worker") is True

    with session_factory() as check:
        failed = check.get(BackgroundJob, job_id)
        assert failed is not None
        assert failed.status == JobStatus.FAILED
        # Precondition: the marker really is stored, so an absent marker in a
        # response proves redaction rather than an empty diagnostic.
        assert TRACEBACK_MARKER in failed.result["errorDetails"]
    return job_id, project_id, admin, manager, member


def test_member_job_detail_never_returns_the_traceback(
    client, db, session_factory, monkeypatch
) -> None:
    job_id, _project_id, _admin, _manager, member = _build_failed_job(
        client, db, session_factory, monkeypatch
    )
    login(client, member.username, MEMBER_PASSWORD)

    response = client.get(f"/api/v1/jobs/{job_id}")

    assert response.status_code == 200
    assert TRACEBACK_MARKER not in response.text
    body = response.json()
    assert body["result"] is not None
    assert "errorDetails" not in body["result"]
    # The safe error category survives -- a member still learns what broke.
    assert body["result"]["errorType"] == "RuntimeError"
    assert body["errorMessage"]
    assert "SELECT users.password_hash" not in body["errorMessage"]
    assert "/srv/papertrail" not in body["errorMessage"]


def test_member_project_job_list_never_returns_the_traceback(
    client, db, session_factory, monkeypatch
) -> None:
    job_id, project_id, _admin, _manager, member = _build_failed_job(
        client, db, session_factory, monkeypatch
    )
    login(client, member.username, MEMBER_PASSWORD)

    response = client.get(f"/api/v1/projects/{project_id}/jobs")

    assert response.status_code == 200
    assert TRACEBACK_MARKER not in response.text
    listed = next(job for job in response.json() if job["id"] == job_id)
    assert "errorDetails" not in (listed["result"] or {})


def test_manager_restart_response_never_returns_the_traceback(
    client, db, session_factory, monkeypatch
) -> None:
    """The restart endpoints echo the job back through the same schema."""
    job_id, project_id, _admin, manager, _member = _build_failed_job(
        client, db, session_factory, monkeypatch
    )
    csrf = login(client, manager.username, MANAGER_PASSWORD)

    response = client.post(
        f"/api/v1/projects/{project_id}/jobs/{job_id}/restart",
        headers={"X-CSRF-Token": csrf},
    )

    assert response.status_code == 200
    assert TRACEBACK_MARKER not in response.text


def test_member_diagnostics_endpoint_redacts_details_and_message(
    client, db, session_factory, monkeypatch
) -> None:
    job_id, _project_id, _admin, _manager, member = _build_failed_job(
        client, db, session_factory, monkeypatch
    )
    login(client, member.username, MEMBER_PASSWORD)

    response = client.get(f"/api/v1/jobs/{job_id}/error")

    assert response.status_code == 200
    assert TRACEBACK_MARKER not in response.text
    body = response.json()
    assert body["errorDetails"] is None
    assert body["errorType"] == "RuntimeError"
    assert "[SQL:" not in body["errorMessage"]
    assert "db-internal.papertrail.local" not in body["errorMessage"]


def test_project_manager_diagnostics_endpoint_returns_the_traceback(
    client, db, session_factory, monkeypatch
) -> None:
    """The positive case: the privileged endpoint is where diagnostics live."""
    job_id, _project_id, _admin, manager, _member = _build_failed_job(
        client, db, session_factory, monkeypatch
    )
    login(client, manager.username, MANAGER_PASSWORD)

    response = client.get(f"/api/v1/jobs/{job_id}/error")

    assert response.status_code == 200
    body = response.json()
    assert TRACEBACK_MARKER in body["errorDetails"]
    assert "Traceback (most recent call last)" in body["errorDetails"]
    assert body["errorMessage"] == FAILURE_MESSAGE


def test_administrator_diagnostics_endpoint_returns_the_traceback(
    client, db, session_factory, monkeypatch
) -> None:
    job_id, _project_id, admin, _manager, _member = _build_failed_job(
        client, db, session_factory, monkeypatch
    )
    login(client, admin.username, ADMIN_PASSWORD)

    response = client.get(f"/api/v1/jobs/{job_id}/error")

    assert response.status_code == 200
    assert TRACEBACK_MARKER in response.json()["errorDetails"]


def test_non_admin_cannot_reach_an_instance_wide_job_at_all(
    client, db, session_factory, monkeypatch
) -> None:
    job_id, _project_id, _admin, _manager, member = _build_failed_job(
        client, db, session_factory, monkeypatch, with_project=False
    )
    login(client, member.username, MEMBER_PASSWORD)

    detail = client.get(f"/api/v1/jobs/{job_id}")
    assert TRACEBACK_MARKER not in detail.text
    assert client.get(f"/api/v1/jobs/{job_id}/error").status_code == 403


def test_sanitizer_drops_diagnostic_keys_and_redacts_message_shapes() -> None:
    """Unit-level guard on the serializer itself, independent of any route."""
    result = public_job_result(
        {
            "errorType": "OperationalError",
            "errorDetails": f"Traceback...{TRACEBACK_MARKER}",
            "traceback": TRACEBACK_MARKER,
            "error": f"boom at /srv/app/{TRACEBACK_MARKER}.py",
            "artifactId": "abc-123",
            "records": 12,
        }
    )
    assert result is not None
    assert TRACEBACK_MARKER not in str(result)
    assert result["errorType"] == "OperationalError"
    assert result["artifactId"] == "abc-123"
    assert result["records"] == 12

    assert "C:\\papertrail" not in (
        public_error_message("failed on C:\\papertrail\\data\\pdfs\\x.pdf") or ""
    )
    assert "10.4.2.9" not in (public_error_message("no route to 10.4.2.9:5432") or "")
    assert "ollama.internal" not in (
        public_error_message("POST https://ollama.internal:11434/api failed") or ""
    )
    assert public_error_message("Diagnostic failure") == "Diagnostic failure"
    assert public_error_message(None) is None
