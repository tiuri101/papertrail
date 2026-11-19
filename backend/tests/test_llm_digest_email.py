"""The "LLM processing finished" email is one debounced digest per project,
not one email per bulk -- releasing publications into screening one at a time
must not mail the owner once per publication."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from sqlalchemy import select

from app.accounts.service import create_user
from app.core.config import Settings
from app.jobs.models import BackgroundJob, JobStatus
from app.jobs.service import claim_job
from app.jobs.worker import run_permanent_failure_hook
from app.llm.models import LlmExtractionRun, LlmTaskType, ProcessingStatus
from app.llm.service import cancel_task_type_jobs
from app.notifications.models import EmailNotification
from app.notifications.service import (
    CHECK_LLM_STAGE_EMAIL_JOB,
    LLM_DIGEST_QUIET_PERIOD,
    check_llm_stage_email_job,
    queue_llm_digest_emails,
    schedule_llm_digest_after_run,
    schedule_llm_digest_check,
)
from app.projects.job_safety import LifecycleOperation, require_no_unfinished_jobs
from app.projects.models import ReviewType
from app.projects.service import create_project
from app.publications.models import Publication


def email_settings(db=None) -> Settings:
    return Settings(
        _env_file=None,
        email_enabled=True,
        public_base_url="https://papertrail.example.org/",
        smtp_host="smtp.example.org",
        smtp_from_address="papertrail@example.org",
    )


def _enable_email(monkeypatch) -> None:
    monkeypatch.setattr(
        "app.notifications.service.effective_instance_settings", email_settings
    )


def _project(db):
    owner = create_user(
        db, "owner", "Project Owner", "secret-password", email="owner@example.org"
    )
    project = create_project(
        db, "Evidence Review", None, ReviewType.SYSTEMATIC_REVIEW, owner
    )
    return project


def _run(
    db,
    project,
    *,
    bulk_id: str | None,
    status: ProcessingStatus,
    completed_at: datetime | None = None,
    job_status: JobStatus | None = None,
) -> LlmExtractionRun:
    """An active run gets a background job (queued unless ``job_status`` says
    otherwise), as the queueing services create it."""
    publication = Publication(project_id=project.id, title="A study")
    db.add(publication)
    db.flush()
    job = None
    if status in (ProcessingStatus.PENDING, ProcessingStatus.PROCESSING):
        job = BackgroundJob(
            project_id=project.id,
            job_type="llm_title_abstract_screening",
            payload={},
            status=job_status or JobStatus.QUEUED,
        )
        db.add(job)
        db.flush()
    run = LlmExtractionRun(
        project_id=project.id,
        publication_id=publication.id,
        task_type=LlmTaskType.TITLE_ABSTRACT_SCREENING,
        input_fingerprint=publication.id.replace("-", "").ljust(64, "0")[:64],
        model="test-model",
        prompt_template_version="title_abstract_screening_v1",
        status=status,
        queued_at=datetime.now(UTC),
        completed_at=completed_at,
        bulk_id=bulk_id,
        background_job_id=job.id if job else None,
    )
    db.add(run)
    db.flush()
    if job is not None:
        job.payload = {"run_id": run.id}
        db.flush()
    return run


def _digest_jobs(db) -> list[BackgroundJob]:
    return list(
        db.scalars(
            select(BackgroundJob).where(
                BackgroundJob.job_type == CHECK_LLM_STAGE_EMAIL_JOB
            )
        )
    )


def test_one_digest_covers_many_single_publication_bulks(db, monkeypatch) -> None:
    _enable_email(monkeypatch)
    project = _project(db)
    now = datetime.now(UTC)
    finished = now - LLM_DIGEST_QUIET_PERIOD - timedelta(minutes=1)
    # What resolving duplicates one by one produces: a separate bulk per
    # publication, each finishing on its own.
    for index in range(5):
        _run(
            db,
            project,
            bulk_id=f"bulk-{index}",
            status=ProcessingStatus.COMPLETED,
            completed_at=finished - timedelta(seconds=index),
        )
    _run(
        db,
        project,
        bulk_id="bulk-failed",
        status=ProcessingStatus.FAILED,
        completed_at=finished,
    )
    # A reviewer's one-off run is not batch work and is not reported.
    _run(db, project, bulk_id=None, status=ProcessingStatus.COMPLETED, completed_at=finished)

    notifications, retry_at = queue_llm_digest_emails(db, project.id, now=now)

    assert retry_at is None
    assert len(notifications) == 1
    assert notifications[0].context["completed_count"] == 5
    assert notifications[0].context["failed_count"] == 1
    assert notifications[0].context["other_count"] == 0
    assert notifications[0].subject == 'LLM processing finished for "Evidence Review"'

    # Everything reported is behind the cursor now.
    assert queue_llm_digest_emails(db, project.id, now=now) == ([], None)
    assert len(list(db.scalars(select(EmailNotification)))) == 1


def test_digest_waits_while_llm_work_is_still_queued(db, monkeypatch) -> None:
    _enable_email(monkeypatch)
    project = _project(db)
    now = datetime.now(UTC)
    _run(
        db,
        project,
        bulk_id="bulk-1",
        status=ProcessingStatus.COMPLETED,
        completed_at=now - timedelta(hours=1),
    )
    pending = _run(db, project, bulk_id="bulk-2", status=ProcessingStatus.PENDING)

    # No retry time: the remaining work schedules the next check when it
    # finishes, so polling while it is queued would only add jobs.
    assert queue_llm_digest_emails(db, project.id, now=now) == ([], None)

    # A queued text-preparation job also counts as work still to come.
    pending.status = ProcessingStatus.COMPLETED
    pending.completed_at = now - timedelta(hours=1)
    preparation = BackgroundJob(
        project_id=project.id,
        job_type="extract_document_text",
        payload={"bulk_id": "bulk-3", "document_id": "document-1"},
        status=JobStatus.QUEUED,
    )
    db.add(preparation)
    db.flush()
    assert queue_llm_digest_emails(db, project.id, now=now)[0] == []

    preparation.status = JobStatus.COMPLETED
    preparation.completed_at = now - timedelta(hours=1)
    db.flush()
    notifications, retry_at = queue_llm_digest_emails(db, project.id, now=now)
    assert retry_at is None
    assert len(notifications) == 1
    assert notifications[0].context["completed_count"] == 2


def test_digest_waits_for_the_quiet_period_after_the_last_finish(
    db, monkeypatch
) -> None:
    _enable_email(monkeypatch)
    project = _project(db)
    now = datetime.now(UTC)
    last_finish = now - timedelta(minutes=2)
    _run(
        db,
        project,
        bulk_id="bulk-1",
        status=ProcessingStatus.COMPLETED,
        completed_at=last_finish,
    )

    notifications, retry_at = queue_llm_digest_emails(db, project.id, now=now)

    assert notifications == []
    assert retry_at == last_finish + LLM_DIGEST_QUIET_PERIOD
    later = last_finish + LLM_DIGEST_QUIET_PERIOD
    assert len(queue_llm_digest_emails(db, project.id, now=later)[0]) == 1


def test_later_work_gets_its_own_digest(db, monkeypatch) -> None:
    _enable_email(monkeypatch)
    project = _project(db)
    now = datetime.now(UTC)
    _run(
        db,
        project,
        bulk_id="bulk-1",
        status=ProcessingStatus.COMPLETED,
        completed_at=now - timedelta(hours=2),
    )
    assert len(queue_llm_digest_emails(db, project.id, now=now)[0]) == 1

    _run(
        db,
        project,
        bulk_id="bulk-2",
        status=ProcessingStatus.FAILED,
        completed_at=now - timedelta(hours=1),
    )
    second, _ = queue_llm_digest_emails(db, project.id, now=now)

    assert len(second) == 1
    assert second[0].context["completed_count"] == 0
    assert second[0].context["failed_count"] == 1


def test_finishing_runs_share_one_waiting_check_pushed_later(
    db, monkeypatch
) -> None:
    _enable_email(monkeypatch)
    project = _project(db)
    first_run = _run(
        db,
        project,
        bulk_id="bulk-1",
        status=ProcessingStatus.COMPLETED,
        completed_at=datetime.now(UTC),
    )
    first = schedule_llm_digest_after_run(db, first_run)
    assert first is not None
    first_due = first.run_after
    assert first_due is not None

    for index in range(20):
        run = _run(
            db,
            project,
            bulk_id=f"bulk-{index + 2}",
            status=ProcessingStatus.COMPLETED,
            completed_at=datetime.now(UTC),
        )
        assert schedule_llm_digest_after_run(db, run) is first

    assert _digest_jobs(db) == [first]
    assert first.run_after is not None and first.run_after >= first_due
    # One-off runs never schedule an email.
    one_off = _run(db, project, bulk_id=None, status=ProcessingStatus.COMPLETED)
    assert schedule_llm_digest_after_run(db, one_off) is None


def test_a_waiting_check_is_not_claimed_before_it_is_due(db, monkeypatch) -> None:
    _enable_email(monkeypatch)
    project = _project(db)
    job = schedule_llm_digest_check(db, project.id)
    assert job is not None
    db.commit()

    assert claim_job(db, "worker-1") is None

    job.run_after = datetime.now(UTC) - timedelta(seconds=1)
    db.commit()
    assert claim_job(db, "worker-1") == job


def test_check_job_reschedules_itself_while_too_early(db, monkeypatch) -> None:
    _enable_email(monkeypatch)
    project = _project(db)
    _run(
        db,
        project,
        bulk_id="bulk-1",
        status=ProcessingStatus.COMPLETED,
        completed_at=datetime.now(UTC),
    )
    running = BackgroundJob(
        project_id=project.id,
        job_type=CHECK_LLM_STAGE_EMAIL_JOB,
        payload={},
        status=JobStatus.RUNNING,
    )
    db.add(running)
    db.flush()

    result = check_llm_stage_email_job(db, running)

    assert result["notification_ids"] == []
    assert "rescheduledFor" in result
    waiting = [job for job in _digest_jobs(db) if job.status == JobStatus.QUEUED]
    assert len(waiting) == 1
    assert waiting[0].run_after is not None
    assert db.scalar(select(EmailNotification)) is None


def test_check_job_does_not_poll_while_llm_work_is_pending(db, monkeypatch) -> None:
    _enable_email(monkeypatch)
    project = _project(db)
    _run(db, project, bulk_id="bulk-1", status=ProcessingStatus.PENDING)
    running = BackgroundJob(
        project_id=project.id,
        job_type=CHECK_LLM_STAGE_EMAIL_JOB,
        payload={},
        status=JobStatus.RUNNING,
    )
    db.add(running)
    db.flush()

    result = check_llm_stage_email_job(db, running)

    assert "rescheduledFor" not in result
    assert [job for job in _digest_jobs(db) if job.status == JobStatus.QUEUED] == []


def test_a_run_whose_job_will_never_run_is_not_pending_work(db, monkeypatch) -> None:
    # A lifecycle rewind cancels queued jobs without touching their runs, and
    # the reaper fails a dead worker's job; neither run will ever finish.
    _enable_email(monkeypatch)
    project = _project(db)
    now = datetime.now(UTC)
    _run(
        db,
        project,
        bulk_id="bulk-1",
        status=ProcessingStatus.COMPLETED,
        completed_at=now - timedelta(hours=1),
    )
    _run(
        db,
        project,
        bulk_id="bulk-2",
        status=ProcessingStatus.PENDING,
        job_status=JobStatus.CANCELLED,
    )
    _run(
        db,
        project,
        bulk_id="bulk-3",
        status=ProcessingStatus.PROCESSING,
        job_status=JobStatus.FAILED,
    )

    notifications, _ = queue_llm_digest_emails(db, project.id, now=now)

    assert len(notifications) == 1


def test_disabling_a_capability_schedules_a_digest_check(db, monkeypatch) -> None:
    _enable_email(monkeypatch)
    project = _project(db)
    _run(db, project, bulk_id="bulk-1", status=ProcessingStatus.PENDING)

    cancel_task_type_jobs(db, project.id, LlmTaskType.TITLE_ABSTRACT_SCREENING)

    assert [job.status for job in _digest_jobs(db)] == [JobStatus.QUEUED]


def test_a_reaped_llm_job_fails_its_run_and_schedules_a_digest_check(
    db, monkeypatch
) -> None:
    _enable_email(monkeypatch)
    project = _project(db)
    run = _run(
        db,
        project,
        bulk_id="bulk-1",
        status=ProcessingStatus.PROCESSING,
        job_status=JobStatus.FAILED,
    )
    job = db.get(BackgroundJob, run.background_job_id)

    run_permanent_failure_hook(db, job, "worker stopped")

    assert run.status == ProcessingStatus.FAILED
    assert run.error_message == "worker stopped"
    assert run.completed_at is not None
    assert [job.status for job in _digest_jobs(db)] == [JobStatus.QUEUED]


def test_no_check_is_scheduled_when_email_is_disabled(db) -> None:
    project = _project(db)
    assert schedule_llm_digest_check(db, project.id) is None
    assert _digest_jobs(db) == []


def test_a_waiting_digest_check_does_not_block_copying_the_project(
    db, monkeypatch
) -> None:
    _enable_email(monkeypatch)
    project = _project(db)
    schedule_llm_digest_check(db, project.id)
    db.flush()

    require_no_unfinished_jobs(db, project.id, operation=LifecycleOperation.CLONE)
