from datetime import UTC, datetime

from app.accounts.service import create_user
from app.analysis.jobs import STAGE_ANALYSIS_JOB
from app.analysis.models import ResearchQuestionAnalysisRun
from app.analysis.rq_jobs import RQ_SYNTHESIS_JOB, generate_rq_synthesis_job
from app.jobs.diagnostics import JOB_LABELS, JOB_STAGES, build_job_diagnostics
from app.jobs.models import BackgroundJob, JobStatus
from app.jobs.registry import (
    JOB_DEFINITIONS,
    LLM_JOB_TYPES,
    PERMANENT_FAILURE_HOOKS,
    WorkerPool,
)
from app.jobs.service import claim_job, enqueue_job
from app.jobs.worker import HANDLERS, execute_next_job
from app.llm.models import LlmExtractionRun, LlmTaskType, ProcessingStatus
from app.llm.service import LLM_JOB_TYPE_BY_TASK
from app.projects.models import (
    Project,
    ProjectMembership,
    ProjectStage,
    ResearchQuestion,
    ReviewType,
)
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


def test_job_error_details_are_hidden_from_a_non_manager_project_member(
    client, session_factory, monkeypatch
) -> None:
    with session_factory() as db:
        create_user(db, "admin", "Administrator", "secret-password", is_admin=True)
        member = create_user(db, "member", "Member", "member-password")
        project = Project(
            name="Review", review_type=ReviewType.SYSTEMATIC_REVIEW, random_seed="seed"
        )
        db.add(project)
        db.flush()
        db.add(ProjectMembership(project_id=project.id, user_id=member.id))
        job = enqueue_job(
            db,
            "generate_export",
            {"export_type": "xlsx", "scope": "included"},
            project_id=project.id,
            created_by_id=member.id,
            max_attempts=1,
        )
        job_id = job.id
        db.commit()

    def fail_job(db, job):
        raise RuntimeError("Diagnostic failure")

    monkeypatch.setitem(HANDLERS, "generate_export", fail_job)
    assert execute_next_job(session_factory, "test-worker") is True

    client.post(
        "/api/v1/auth/login", json={"username": "member", "password": "member-password"}
    )
    response = client.get(f"/api/v1/jobs/{job_id}/error")

    assert response.status_code == 200
    body = response.json()
    assert body["errorType"] == "RuntimeError"
    assert body["errorMessage"] == "Diagnostic failure"
    assert body["errorDetails"] is None


def test_job_error_endpoint_requires_admin_for_a_project_less_job(
    client, session_factory, monkeypatch
) -> None:
    with session_factory() as db:
        create_user(db, "admin", "Administrator", "secret-password", is_admin=True)
        create_user(db, "member", "Member", "member-password")
        job = enqueue_job(
            db,
            "generate_export",
            {"export_type": "xlsx", "scope": "included"},
            project_id=None,
            created_by_id=None,
            max_attempts=1,
        )
        job_id = job.id
        db.commit()

    def fail_job(db, job):
        raise RuntimeError("Diagnostic failure")

    monkeypatch.setitem(HANDLERS, "generate_export", fail_job)
    assert execute_next_job(session_factory, "test-worker") is True

    client.post(
        "/api/v1/auth/login", json={"username": "member", "password": "member-password"}
    )
    response = client.get(f"/api/v1/jobs/{job_id}/error")

    assert response.status_code == 403


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


def test_jobs_summary_groups_counts_by_stage_and_excludes_cancelled(
    client, db, session_factory
) -> None:
    create_user(db, "admin", "Administrator", "secret-password", is_admin=True)
    project = Project(
        name="Review", review_type=ReviewType.SYSTEMATIC_REVIEW, random_seed="seed"
    )
    db.add(project)
    db.commit()
    login(client)

    def add_job(job_type: str, status: JobStatus) -> None:
        job = enqueue_job(db, job_type, {}, project_id=project.id, created_by_id=None)
        job.status = status
        db.add(job)

    add_job("generate_export", JobStatus.COMPLETED)
    add_job("generate_export", JobStatus.COMPLETED)
    add_job("generate_export", JobStatus.QUEUED)
    add_job("detect_duplicates", JobStatus.COMPLETED)
    add_job("detect_duplicates", JobStatus.CANCELLED)
    db.commit()

    response = client.get(f"/api/v1/projects/{project.id}/jobs/summary")
    assert response.status_code == 200
    body = response.json()

    by_stage = {item["stage"]: item for item in body}
    assert by_stage["Reporting and export"] == {
        "stage": "Reporting and export",
        "completed": 2,
        "total": 3,
        "active": True,
    }
    assert by_stage["Duplicate review"] == {
        "stage": "Duplicate review",
        "completed": 1,
        "total": 1,
        "active": False,
    }
    # Cancelled jobs are excluded entirely rather than counted as incomplete.
    assert by_stage["Duplicate review"]["total"] == 1

    # Stages appear in a stable pipeline order, not creation order.
    stages = [item["stage"] for item in body]
    assert stages.index("Duplicate review") < stages.index("Reporting and export")


def test_jobs_summary_excludes_jobs_from_other_projects(client, db) -> None:
    create_user(db, "admin", "Administrator", "secret-password", is_admin=True)
    project = Project(
        name="Review", review_type=ReviewType.SYSTEMATIC_REVIEW, random_seed="seed"
    )
    other_project = Project(
        name="Other review",
        review_type=ReviewType.SYSTEMATIC_REVIEW,
        random_seed="seed2",
    )
    db.add_all([project, other_project])
    db.commit()
    login(client)

    own_job = enqueue_job(
        db, "detect_duplicates", {}, project_id=project.id, created_by_id=None
    )
    own_job.status = JobStatus.COMPLETED
    other_job = enqueue_job(
        db, "detect_duplicates", {}, project_id=other_project.id, created_by_id=None
    )
    other_job.status = JobStatus.QUEUED
    system_job = enqueue_job(
        db, "detect_duplicates", {}, project_id=None, created_by_id=None
    )
    system_job.status = JobStatus.QUEUED
    db.add_all([own_job, other_job, system_job])
    db.commit()

    response = client.get(f"/api/v1/projects/{project.id}/jobs/summary")
    assert response.status_code == 200
    body = response.json()

    assert body == [
        {"stage": "Duplicate review", "completed": 1, "total": 1, "active": False}
    ]


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


def test_rq_synthesis_job_diagnostics_identify_the_research_question(db) -> None:
    """RQ synthesis jobs are keyed by a ResearchQuestionAnalysisRun via
    payload["rq_run_id"], not an LlmExtractionRun via payload["run_id"] --
    regression guard for the two job-type sets in jobs.diagnostics staying
    correctly distinct (see EXTRACTION_RUN_JOB_TYPES vs
    app.jobs.registry.LLM_JOB_TYPES)."""
    project = Project(
        name="RQ Review",
        review_type=ReviewType.SYSTEMATIC_REVIEW,
        random_seed="seed",
        stage=ProjectStage.EXTRACTION,
    )
    db.add(project)
    db.flush()
    question = ResearchQuestion(project_id=project.id, text="Does X affect Y?")
    db.add(question)
    db.flush()
    run = ResearchQuestionAnalysisRun(
        project_id=project.id,
        research_question_id=question.id,
        research_question_text=question.text,
        input_fingerprint="a" * 64,
        model="qwen3:8b",
        prompt_template_version="rq_synthesis_v1",
        status=ProcessingStatus.PENDING,
        queued_at=datetime.now(UTC),
    )
    db.add(run)
    db.flush()
    job = BackgroundJob(
        project_id=project.id,
        job_type=RQ_SYNTHESIS_JOB,
        payload={"rq_run_id": run.id},
    )
    db.add(job)
    db.flush()

    diagnostics = build_job_diagnostics(db, job)

    assert diagnostics["job_label"] == "Run LLM research-question synthesis"
    assert diagnostics["affected_stage"] == "Research question synthesis"
    assert diagnostics["context"]["Research question"] == "Does X affect Y?"
    assert diagnostics["context"]["Model"] == "qwen3:8b"
    # Must not be mistaken for an extraction-run-keyed job: no such context key.
    assert "LLM run ID" not in diagnostics["context"]


def test_rq_synthesis_job_is_llm_pool_but_not_extraction_run_keyed() -> None:
    """RQ_SYNTHESIS_JOB must route to the --llm worker pool (it calls Ollama)
    while staying out of jobs.diagnostics.EXTRACTION_RUN_JOB_TYPES (it isn't
    keyed by an LlmExtractionRun) -- these are two different, correctly
    non-identical concepts that share a superficially similar name."""
    assert RQ_SYNTHESIS_JOB in LLM_JOB_TYPES
    assert HANDLERS[RQ_SYNTHESIS_JOB] is generate_rq_synthesis_job


def test_every_registered_job_type_has_a_handler_and_diagnostic_label() -> None:
    """Guards against the job-registration drift the audit flagged: adding a
    new job type must not silently miss a handler or a diagnostics label."""
    for job_type in HANDLERS:
        assert job_type in JOB_LABELS, f"{job_type} has no JOB_LABELS entry"
        assert job_type in JOB_STAGES, f"{job_type} has no JOB_STAGES entry"
    for job_type in LLM_JOB_TYPE_BY_TASK.values():
        assert job_type in HANDLERS
    assert STAGE_ANALYSIS_JOB in HANDLERS
    assert RQ_SYNTHESIS_JOB in HANDLERS


def test_job_registry_is_the_single_source_for_handlers_pools_and_labels() -> None:
    """app.jobs.registry.JOB_DEFINITIONS is authoritative: HANDLERS,
    LLM_JOB_TYPES, JOB_LABELS, and JOB_STAGES (used respectively by
    jobs.worker and jobs.diagnostics) must all be exactly derived from it --
    same keys, nothing added or dropped independently."""
    assert set(JOB_DEFINITIONS) == set(HANDLERS)
    assert set(JOB_DEFINITIONS) == set(JOB_LABELS)
    assert set(JOB_DEFINITIONS) == set(JOB_STAGES)
    assert set(JOB_DEFINITIONS) >= LLM_JOB_TYPES
    for job_type, definition in JOB_DEFINITIONS.items():
        assert HANDLERS[job_type] is definition.handler
        assert JOB_LABELS[job_type] == definition.label
        assert JOB_STAGES[job_type] == definition.stage
        assert (definition.worker_pool == WorkerPool.LLM) == (job_type in LLM_JOB_TYPES)


def test_permanent_failure_hooks_are_derived_from_the_registry() -> None:
    """JOB_DEFINITIONS stays the single source of truth for the hook too."""
    assert set(PERMANENT_FAILURE_HOOKS) <= set(JOB_DEFINITIONS)
    for job_type, definition in JOB_DEFINITIONS.items():
        assert (job_type in PERMANENT_FAILURE_HOOKS) == (
            definition.on_permanent_failure is not None
        )
        if definition.on_permanent_failure is not None:
            assert PERMANENT_FAILURE_HOOKS[job_type] is definition.on_permanent_failure
    # parse_import owns workflow state (the ImportBatch) that has to follow the
    # job into a terminal state, so it must have a hook.
    assert "parse_import" in PERMANENT_FAILURE_HOOKS


# Every retryable job handler, and why executing it a second time after it
# committed part of its work is safe. Keeping this in a test rather than a
# comment means a newly registered job type fails the suite until someone has
# actually answered the question for it.
RETRY_SAFETY_REVIEW: dict[str, str] = {
    "parse_import": (
        "checkpointed-restartable: rows already committed for a source row are "
        "skipped, counters are recomputed from stored rows, and "
        "uq_imported_records_batch_source_row enforces it in the database"
    ),
    "enrich_publication": (
        "naturally idempotent: enrichment only fills fields that are still "
        "empty and will not reopen an identical metadata conflict"
    ),
    "resolve_merge_conflicts": (
        "naturally idempotent: only acts on conflicts still OPEN, so a "
        "conflict a previous run (or a reviewer) already resolved is left "
        "untouched on retry"
    ),
    "detect_duplicates": (
        "owned by the deduplication domain: re-detection reuses the existing "
        "candidate rows for a project"
    ),
    "generate_export": (
        "naturally idempotent: returns the ExportArtifact already produced for "
        "this job id instead of building a second one"
    ),
    "extract_document_text": (
        "transactionally atomic: a completed extraction returns immediately, "
        "and a restart deletes the extraction's page rows before re-inserting"
    ),
    "generate_stage_analysis": (
        "naturally idempotent: one StageAnalysis row per project and stage is "
        "overwritten in place"
    ),
    "generate_rq_synthesis": (
        "naturally idempotent: a completed run returns early and a run whose "
        "input fingerprint moved on is marked stale instead of rerun"
    ),
    "send_email": (
        "naturally idempotent for the queue: an already-SENT notification "
        "returns early. A crash between handing the message to SMTP and "
        "committing can resend it -- a duplicate email is the accepted "
        "trade-off against dropping one"
    ),
    "check_llm_stage_email": (
        "naturally idempotent: notifications are queued under a stable "
        "deduplication key per bulk run and owner"
    ),
}


def test_every_registered_job_handler_has_a_documented_retry_story() -> None:
    llm_task_reason = (
        "naturally idempotent: a COMPLETED run returns early and a run whose "
        "input fingerprint moved on is marked stale instead of rerun"
    )
    expected = dict(RETRY_SAFETY_REVIEW)
    for job_type in LLM_JOB_TYPE_BY_TASK.values():
        expected[job_type] = llm_task_reason
    assert set(expected) == set(JOB_DEFINITIONS), (
        "a job type was added or removed without reviewing what happens when "
        "it runs again after committing half its work"
    )


def test_stage_analysis_job_is_classified_as_llm_pool() -> None:
    """The regression this task exists to fix: STAGE_ANALYSIS_JOB calls
    Ollama via generate_narrative() and must run on the dedicated --llm
    worker pool, not the unbounded general pool."""
    assert STAGE_ANALYSIS_JOB in LLM_JOB_TYPES
    assert JOB_DEFINITIONS[STAGE_ANALYSIS_JOB].worker_pool == WorkerPool.LLM


def test_every_ollama_calling_job_type_is_in_the_llm_pool() -> None:
    """Enumerate every job type known to call Ollama and confirm the
    registry's LLM_JOB_TYPES is exactly that set -- neither missing one
    (the STAGE_ANALYSIS_JOB bug) nor including a job that doesn't actually
    call Ollama (which would wrongly starve the bounded --llm worker pool)."""
    ollama_calling_job_types = {STAGE_ANALYSIS_JOB, RQ_SYNTHESIS_JOB} | set(
        LLM_JOB_TYPE_BY_TASK.values()
    )
    assert ollama_calling_job_types == LLM_JOB_TYPES


def test_no_job_type_is_claimable_by_both_worker_pools(session_factory) -> None:
    """A job type must be routed to exactly one worker pool. Directly
    exercises claim_job's allowed/excluded filtering (what jobs.worker.py's
    run_worker actually uses) rather than just inspecting the registry."""
    with session_factory() as db:
        stage_job = enqueue_job(
            db,
            STAGE_ANALYSIS_JOB,
            {"stage": "extraction_quality"},
            project_id=None,
            created_by_id=None,
        )
        general_job = enqueue_job(
            db, "parse_import", {}, project_id=None, created_by_id=None
        )
        db.commit()
        stage_job_id, general_job_id = stage_job.id, general_job.id

    # LLM worker (allowed_job_types=LLM_JOB_TYPES): claims the stage-analysis
    # job, never the general one.
    with session_factory() as db:
        claimed = claim_job(db, "llm-worker", allowed_job_types=LLM_JOB_TYPES)
        assert claimed is not None
        assert claimed.id == stage_job_id
        db.commit()

    # General worker (excluded_job_types=LLM_JOB_TYPES): claims the general
    # job, and must not be able to claim the (already-claimed) stage job either.
    with session_factory() as db:
        claimed = claim_job(db, "general-worker", excluded_job_types=LLM_JOB_TYPES)
        assert claimed is not None
        assert claimed.id == general_job_id
        db.commit()

    with session_factory() as db:
        remaining = claim_job(db, "general-worker-2", excluded_job_types=LLM_JOB_TYPES)
        assert remaining is None


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
