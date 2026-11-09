from __future__ import annotations

import logging
import signal
import sys
import traceback
from collections.abc import Callable
from concurrent.futures import Future, ThreadPoolExecutor
from datetime import UTC, datetime
from threading import Event, Thread
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from app.audit.service import record_audit
from app.core.config import get_settings
from app.core.logging import configure_logging
from app.db import models as _models  # noqa: F401  # registers all SQLAlchemy models
from app.db.session import SessionFactory
from app.instance_settings.service import effective_instance_settings
from app.jobs.models import BackgroundJob, JobStatus
from app.jobs.registry import HANDLERS, LLM_JOB_TYPES, PERMANENT_FAILURE_HOOKS
from app.jobs.service import claim_job, reap_abandoned_jobs, renew_job_lease
from app.llm.service import TEXT_JOB
from app.notifications.service import (
    SEND_EMAIL_JOB,
    record_email_job_failure,
    schedule_llm_digest_after_run,
    schedule_llm_digest_check,
)

logger = logging.getLogger(__name__)
Handler = Callable[[Session, BackgroundJob], dict[str, Any]]


def maintain_lease(
    session_factory: sessionmaker[Session],
    job_id: str,
    worker_id: str,
    lease_seconds: int,
    stop: Event,
) -> None:
    interval = max(1.0, lease_seconds / 3)
    while not stop.wait(interval):
        try:
            with session_factory() as db:
                if not renew_job_lease(db, job_id, worker_id, lease_seconds):
                    return
        except Exception:
            logger.exception("Could not renew lease for background job %s", job_id)


def job_cancelled_meanwhile(db: Session, job_id: str) -> bool:
    """Has this job's row been set to CANCELLED by someone else while we ran?

    A project manager's "cancel all jobs" action flips RUNNING rows straight
    to CANCELLED (see ``cancel_project_jobs``). The worker cannot interrupt a
    handler that is already executing, so it re-reads the row's committed
    status once the handler returns and honours a cancellation it finds --
    the equivalent of the LLM path's ``was_cancelled`` check.
    """
    status = db.execute(
        select(BackgroundJob.status).where(BackgroundJob.id == job_id)
    ).scalar_one_or_none()
    return status == JobStatus.CANCELLED


def run_permanent_failure_hook(db: Session, job: BackgroundJob, error: str) -> None:
    """Let the owning domain react to a job that has failed for good.

    Runs in a SAVEPOINT: a hook that raises must never destroy the failure
    record the worker is in the middle of writing, and must never leave a
    partially applied domain change behind either.
    """
    hook = PERMANENT_FAILURE_HOOKS.get(job.job_type)
    if hook is None:
        return
    try:
        with db.begin_nested():
            hook(db, job, error)
    except Exception:
        logger.exception(
            "Permanent-failure hook for background job %s (%s) failed",
            job.id,
            job.job_type,
        )


def fail_abandoned_jobs(session_factory: sessionmaker[Session]) -> int:
    """Record terminal failure for jobs whose worker died mid-execution."""
    try:
        with session_factory() as db:
            abandoned = reap_abandoned_jobs(db)
            for job in abandoned:
                logger.warning(
                    "Background job %s (%s) was abandoned by worker %s; "
                    "no attempts left, marking failed",
                    job.id,
                    job.job_type,
                    job.locked_by,
                )
                run_permanent_failure_hook(db, job, job.error_message or "")
                record_audit(
                    db,
                    action="job.failed",
                    entity_type="background_job",
                    entity_id=job.id,
                    project_id=job.project_id,
                    actor_id=job.created_by_id,
                    summary=f"Background job {job.job_type} failed",
                    metadata={"error": job.error_message},
                )
            db.commit()
            return len(abandoned)
    except Exception:
        logger.exception("Failed to reap abandoned background jobs")
        return 0


def execute_next_job(
    session_factory: sessionmaker[Session],
    worker_id: str,
    *,
    allowed_job_types: set[str] | None = None,
    excluded_job_types: set[str] | None = None,
) -> bool:
    fail_abandoned_jobs(session_factory)
    try:
        with session_factory() as claim_session:
            settings = effective_instance_settings(claim_session)
            job = claim_job(
                claim_session,
                worker_id,
                settings.job_lease_seconds,
                allowed_job_types=allowed_job_types,
                excluded_job_types=excluded_job_types,
            )
            if job is None:
                claim_session.rollback()
                return False
            job_id = job.id
            job_type = job.job_type
            claim_session.commit()
    except Exception:
        logger.exception("Failed to claim a background job")
        return False
    logger.info("Claimed background job %s (%s)", job_id, job_type)

    lease_stop = Event()
    heartbeat = Thread(
        target=maintain_lease,
        args=(
            session_factory,
            job_id,
            worker_id,
            settings.job_lease_seconds,
            lease_stop,
        ),
        daemon=True,
        name=f"papertrail-lease-{job_id}",
    )
    heartbeat.start()
    try:
        with session_factory() as db:
            job = db.get(BackgroundJob, job_id)
            assert job is not None
            try:
                logger.info("Starting background job %s (%s)", job_id, job_type)
                handler = HANDLERS[job.job_type]
                result = handler(db, job)
                db.flush()
                if job_cancelled_meanwhile(db, job_id):
                    db.rollback()
                    logger.info(
                        "Background job %s (%s) was cancelled while running; "
                        "discarding its result",
                        job_id,
                        job_type,
                    )
                    return True
                job.status = JobStatus.COMPLETED
                job.completed_at = datetime.now(UTC)
                job.lease_until = None
                job.error_message = None
                job.result = result
                if job.job_type in LLM_JOB_TYPES:
                    from app.llm.models import LlmExtractionRun, LlmTaskType

                    run = db.get(LlmExtractionRun, str(job.payload.get("run_id")))
                    if run is not None:
                        schedule_llm_digest_after_run(db, run)
                        if run.task_type == LlmTaskType.EXTRACTION_VALIDATION:
                            from app.projects.lifecycle import (
                                evaluate_project_completion,
                            )
                            from app.projects.models import Project

                            project = db.get(Project, run.project_id)
                            if project is not None:
                                evaluate_project_completion(db, project)
                if (
                    job.job_type == TEXT_JOB
                    and job.payload.get("bulk_id")
                    and job.project_id
                ):
                    schedule_llm_digest_check(db, job.project_id)
                record_audit(
                    db,
                    action="job.completed",
                    entity_type="background_job",
                    entity_id=job.id,
                    project_id=job.project_id,
                    actor_id=job.created_by_id,
                    summary=f"Completed background job {job.job_type}",
                )
                db.commit()
                logger.info("Finished background job %s (%s)", job_id, job_type)
            except Exception as exc:
                error_details = traceback.format_exc()
                db.rollback()
                job = db.get(BackgroundJob, job_id)
                assert job is not None
                if job.status == JobStatus.CANCELLED:
                    logger.info(
                        "Background job %s (%s) was cancelled while running; "
                        "not recording its failure or retrying it",
                        job_id,
                        job_type,
                    )
                    return True
                job.status = (
                    JobStatus.QUEUED
                    if job.attempts < job.max_attempts
                    else JobStatus.FAILED
                )
                job.error_message = str(exc)
                job.result = {
                    "errorType": type(exc).__name__,
                    "errorDetails": error_details,
                }
                job.lease_until = None
                if job.status == JobStatus.FAILED:
                    job.completed_at = datetime.now(UTC)
                if job.job_type in LLM_JOB_TYPES:
                    from app.llm.models import (
                        LlmExtractionRun,
                        LlmTaskType,
                        ProcessingStatus,
                    )

                    run = db.get(LlmExtractionRun, str(job.payload.get("run_id")))
                    if run and run.status in {
                        ProcessingStatus.PENDING,
                        ProcessingStatus.PROCESSING,
                    }:
                        if job.status == JobStatus.QUEUED:
                            run.status = ProcessingStatus.PENDING
                            run.started_at = None
                            run.error_type = None
                            run.error_message = None
                        else:
                            run.status = ProcessingStatus.FAILED
                            run.error_type = "transient_retries_exhausted"
                            run.error_message = str(exc)[:2000]
                            run.completed_at = datetime.now(UTC)
                            schedule_llm_digest_after_run(db, run)
                            if run.task_type == LlmTaskType.EXTRACTION_VALIDATION:
                                from app.projects.lifecycle import (
                                    evaluate_project_completion,
                                )
                                from app.projects.models import Project

                                project = db.get(Project, run.project_id)
                                if project is not None:
                                    evaluate_project_completion(db, project)
                if (
                    job.status == JobStatus.FAILED
                    and job.job_type == TEXT_JOB
                    and job.payload.get("bulk_id")
                    and job.project_id
                ):
                    schedule_llm_digest_check(db, job.project_id)
                if job.job_type == SEND_EMAIL_JOB:
                    record_email_job_failure(db, job, exc)
                if job.status == JobStatus.FAILED:
                    run_permanent_failure_hook(db, job, str(exc))
                    record_audit(
                        db,
                        action="job.failed",
                        entity_type="background_job",
                        entity_id=job.id,
                        project_id=job.project_id,
                        actor_id=job.created_by_id,
                        summary=f"Background job {job.job_type} failed",
                        metadata={"error": str(exc)},
                    )
                db.commit()
                if job.status == JobStatus.QUEUED:
                    logger.warning(
                        "Background job %s attempt %s/%s failed; queued for retry",
                        job_id,
                        job.attempts,
                        job.max_attempts,
                        exc_info=True,
                    )
                else:
                    logger.exception("Background job %s failed", job_id)
            return True
    finally:
        lease_stop.set()
        heartbeat.join(timeout=2)


def run_worker(*, llm_only: bool = False) -> None:
    configure_logging()
    settings = get_settings()
    stop = Event()
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    worker_id = f"{'llm-worker' if llm_only else 'worker'}-{id(stop)}"
    thread_count = (
        settings.llm_max_concurrent_jobs if llm_only else settings.worker_threads
    )
    allowed_job_types = LLM_JOB_TYPES if llm_only else None
    excluded_job_types = None if llm_only else LLM_JOB_TYPES
    logger.info(
        "Papertrail worker starting (worker_id=%s, version=%s, threads=%d, poll_interval=%ss)",
        worker_id,
        settings.app_version,
        thread_count,
        settings.job_poll_interval_seconds,
    )
    with ThreadPoolExecutor(
        max_workers=thread_count,
        thread_name_prefix="papertrail",
    ) as executor:
        futures: set[Future[bool]] = set()
        while not stop.is_set():
            futures = {future for future in futures if not future.done()}
            available = thread_count - len(futures)
            for _ in range(available):
                futures.add(
                    executor.submit(
                        execute_next_job,
                        SessionFactory,
                        worker_id,
                        allowed_job_types=allowed_job_types,
                        excluded_job_types=excluded_job_types,
                    )
                )
            stop.wait(settings.job_poll_interval_seconds)


if __name__ == "__main__":
    run_worker(llm_only="--llm" in sys.argv)
