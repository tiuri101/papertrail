from datetime import UTC, datetime

from app.accounts.service import create_user
from app.jobs.diagnostics import build_job_diagnostics
from app.jobs.models import BackgroundJob, JobStatus
from app.jobs.service import enqueue_job
from app.jobs.worker import HANDLERS, execute_next_job
from app.llm.models import LlmExtractionRun, LlmTaskType, ProcessingStatus
from app.llm.service import LLM_JOB_TYPE_BY_TASK
from app.projects.models import Project, ProjectStage, ReviewType
from app.publications.models import Publication


def login(client) -> str:
    response = client.post(
        "/api/v1/auth/login", json={"username": "admin", "password": "secret-password"}
    )
    return response.json()["csrfToken"]


def test_failed_job_diagnostic_traceback_can_be_retrieved(
    client, session_factory, monkeypatch
) -> None:
    with session_factory() as db:
        admin = create_user(
            db,
            "job-admin",
            "Job Administrator",
            "secret-password",
            is_admin=True,
        )
        job = enqueue_job(
            db,
            "generate_export",
            {"export_type": "xlsx", "scope": "included"},
            project_id=None,
            created_by_id=admin.id,
            max_attempts=1,
        )
        job_id = job.id
        db.commit()

    def fail_job(db, job):
        raise RuntimeError("Diagnostic failure")

    monkeypatch.setitem(HANDLERS, "generate_export", fail_job)
    assert execute_next_job(session_factory, "test-worker") is True

    with session_factory() as db:
        failed_job = db.get(BackgroundJob, job_id)
        assert failed_job is not None
        assert failed_job.status == JobStatus.FAILED
        assert failed_job.error_message == "Diagnostic failure"
        assert failed_job.completed_at is not None
        assert failed_job.result is not None
        assert failed_job.result["errorType"] == "RuntimeError"
        assert "RuntimeError: Diagnostic failure" in failed_job.result["errorDetails"]

    login = client.post(
        "/api/v1/auth/login",
        json={"username": "job-admin", "password": "secret-password"},
    )
    assert login.status_code == 200
    response = client.get(f"/api/v1/jobs/{job_id}/error")

    assert response.status_code == 200
    body = response.json()
    assert body["jobType"] == "generate_export"
    assert body["jobLabel"] == "Generate project export"
    assert body["affectedStage"] == "Reporting and export"
    assert body["attempt"] == 1
    assert body["maxAttempts"] == 1
    assert body["context"] == {"Export format": "xlsx", "Export scope": "included"}
    assert body["errorType"] == "RuntimeError"
    assert body["errorMessage"] == "Diagnostic failure"
    assert "RuntimeError: Diagnostic failure" in body["errorDetails"]


def test_a_failed_job_can_be_manually_restarted(
    client, db, session_factory, monkeypatch
) -> None:
    create_user(db, "admin", "Administrator", "secret-password", is_admin=True)
    project = Project(
        name="Review", review_type=ReviewType.SYSTEMATIC_REVIEW, random_seed="seed"
    )
    db.add(project)
    db.commit()
    csrf = login(client)

    job = enqueue_job(
        db,
        "generate_export",
        {"export_type": "xlsx", "scope": "included"},
        project_id=project.id,
        created_by_id=None,
        max_attempts=1,
    )
    job_id = job.id
    db.commit()

    def fail_job(db, job):
        raise RuntimeError("boom")

    monkeypatch.setitem(HANDLERS, "generate_export", fail_job)
    assert execute_next_job(session_factory, "test-worker") is True

    with session_factory() as check:
        failed_job = check.get(BackgroundJob, job_id)
        assert failed_job is not None
        assert failed_job.status == JobStatus.FAILED

    not_failed = client.post(
        f"/api/v1/projects/{project.id}/jobs/{job_id}/restart",
        headers={"X-CSRF-Token": csrf},
    )
    assert not_failed.status_code == 200
    assert not_failed.json()["status"] == "queued"

    with session_factory() as check:
        restarted = check.get(BackgroundJob, job_id)
        assert restarted is not None
        assert restarted.status == JobStatus.QUEUED
        assert restarted.attempts == 0
        assert restarted.error_message is None
        assert restarted.completed_at is None

    already_queued = client.post(
        f"/api/v1/projects/{project.id}/jobs/{job_id}/restart",
        headers={"X-CSRF-Token": csrf},
    )
    assert already_queued.status_code == 400


def test_bulk_restart_only_restarts_failed_jobs(
    client, db, session_factory, monkeypatch
) -> None:
    create_user(db, "admin", "Administrator", "secret-password", is_admin=True)
    project = Project(
        name="Review", review_type=ReviewType.SYSTEMATIC_REVIEW, random_seed="seed"
    )
    db.add(project)
    db.commit()
    csrf = login(client)

    failing_job = enqueue_job(
        db,
        "generate_export",
        {"export_type": "xlsx", "scope": "included"},
        project_id=project.id,
        created_by_id=None,
        max_attempts=1,
    )
    running_job = enqueue_job(
        db,
        "generate_export",
        {"export_type": "xlsx", "scope": "included"},
        project_id=project.id,
        created_by_id=None,
        max_attempts=1,
    )
    db.commit()
    failing_job_id = failing_job.id
    running_job_id = running_job.id

    def fail_job(db, job):
        raise RuntimeError("boom")

    monkeypatch.setitem(HANDLERS, "generate_export", fail_job)
    assert execute_next_job(session_factory, "test-worker") is True

    response = client.post(
        f"/api/v1/projects/{project.id}/jobs/restart",
        json={"jobIds": [failing_job_id, running_job_id]},
        headers={"X-CSRF-Token": csrf},
    )
    assert response.status_code == 200
    restarted_ids = [job["id"] for job in response.json()]
    assert restarted_ids == [failing_job_id]

    with session_factory() as check:
        still_queued = check.get(BackgroundJob, running_job_id)
        assert still_queued is not None
        assert still_queued.status == JobStatus.QUEUED
        assert still_queued.attempts == 0


def test_llm_job_diagnostics_identify_the_exact_task_stage_and_publication(db) -> None:
    project = Project(
        name="LLM Review",
        review_type=ReviewType.SYSTEMATIC_REVIEW,
        random_seed="seed",
        stage=ProjectStage.FULL_TEXT,
    )
    db.add(project)
    db.flush()
    publication = Publication(project_id=project.id, title="The affected paper")
    db.add(publication)
    db.flush()
    run = LlmExtractionRun(
        project_id=project.id,
        publication_id=publication.id,
        task_type=LlmTaskType.FULL_TEXT_SCREENING,
        model="qwen3:8b",
        prompt_template_version="full-text-v1",
        queued_at=datetime.now(UTC),
    )
    db.add(run)
    db.flush()
    job = BackgroundJob(
        project_id=project.id,
        job_type=LLM_JOB_TYPE_BY_TASK[LlmTaskType.FULL_TEXT_SCREENING],
        payload={"run_id": run.id},
    )
    db.add(job)
    db.flush()

    diagnostics = build_job_diagnostics(db, job)

    assert diagnostics["job_label"] == "Run LLM full-text screening"
    assert diagnostics["affected_stage"] == "Full-text screening"
    assert diagnostics["project_stage"] == "Full-text screening"
    assert diagnostics["context"]["LLM task"] == "Full-text screening"
    assert diagnostics["context"]["Publication"] == "The affected paper"
    assert diagnostics["context"]["Publication ID"] == publication.id


def test_retried_llm_job_returns_run_to_pending(session_factory, monkeypatch) -> None:
    with session_factory() as db:
        project = Project(
            name="Retry Review",
            review_type=ReviewType.SYSTEMATIC_REVIEW,
            random_seed="seed",
        )
        db.add(project)
        db.flush()
        publication = Publication(project_id=project.id, title="Retry paper")
        db.add(publication)
        db.flush()
        run = LlmExtractionRun(
            project_id=project.id,
            publication_id=publication.id,
            task_type=LlmTaskType.TITLE_ABSTRACT_SCREENING,
            model="qwen3:8b",
            prompt_template_version="title-abstract-v1",
            queued_at=datetime.now(UTC),
        )
        db.add(run)
        db.flush()
        job = BackgroundJob(
            project_id=project.id,
            job_type=LLM_JOB_TYPE_BY_TASK[LlmTaskType.TITLE_ABSTRACT_SCREENING],
            payload={"run_id": run.id},
            max_attempts=2,
        )
        db.add(job)
        db.flush()
        run.background_job_id = job.id
        run_id = run.id
        job_id = job.id
        db.commit()

    def fail_after_start(db, job):
        active_run = db.get(LlmExtractionRun, str(job.payload["run_id"]))
        assert active_run is not None
        active_run.status = ProcessingStatus.PROCESSING
        active_run.started_at = datetime.now(UTC)
        db.commit()
        raise RuntimeError("temporary inference failure")

    monkeypatch.setitem(
        HANDLERS,
        LLM_JOB_TYPE_BY_TASK[LlmTaskType.TITLE_ABSTRACT_SCREENING],
        fail_after_start,
    )
    assert execute_next_job(session_factory, "test-llm-worker") is True

    with session_factory() as db:
        retried_job = db.get(BackgroundJob, job_id)
        retried_run = db.get(LlmExtractionRun, run_id)
        assert retried_job is not None
        assert retried_run is not None
        assert retried_job.status == JobStatus.QUEUED
        assert retried_job.error_message == "temporary inference failure"
        assert retried_run.status == ProcessingStatus.PENDING
        assert retried_run.started_at is None
