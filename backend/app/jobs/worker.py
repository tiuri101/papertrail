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

from sqlalchemy.orm import Session, sessionmaker

from app.analysis.jobs import STAGE_ANALYSIS_JOB, generate_stage_analysis_job
from app.audit.service import record_audit
from app.core.config import get_settings
from app.core.logging import configure_logging
from app.db import models as _models  # noqa: F401  # registers all SQLAlchemy models
from app.db.session import SessionFactory
from app.deduplication.jobs import detect_duplicates_job
from app.imports.service import process_import_job
from app.jobs.models import BackgroundJob, JobStatus
from app.jobs.service import claim_job, renew_job_lease
from app.llm.service import LLM_JOB_TYPES, TEXT_JOB
from app.llm.task_execution import run_llm_task_job
from app.llm.text_extraction import extract_document_text_job
from app.notifications.service import (
    CHECK_LLM_STAGE_EMAIL_JOB,
    SEND_EMAIL_JOB,
    check_llm_stage_email_job,
    queue_llm_bulk_completion_check,
    queue_llm_stage_completion_check,
    record_email_job_failure,
    send_email_job,
)
from app.publications.jobs import enrich_publication_job
from app.reporting.jobs import generate_export_job

logger = logging.getLogger(__name__)
Handler = Callable[[Session, BackgroundJob], dict[str, Any]]
HANDLERS: dict[str, Handler] = {
    "parse_import": process_import_job,
    "enrich_publication": enrich_publication_job,
    "detect_duplicates": detect_duplicates_job,
    "generate_export": generate_export_job,
    STAGE_ANALYSIS_JOB: generate_stage_analysis_job,
    TEXT_JOB: extract_document_text_job,
    **{job_type: run_llm_task_job for job_type in LLM_JOB_TYPES},
    SEND_EMAIL_JOB: send_email_job,
    CHECK_LLM_STAGE_EMAIL_JOB: check_llm_stage_email_job,
}


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


def execute_next_job(
    session_factory: sessionmaker[Session],
    worker_id: str,
    *,
    allowed_job_types: set[str] | None = None,
    excluded_job_types: set[str] | None = None,
) -> bool:
    settings = get_settings()
    try:
        with session_factory() as claim_session:
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
                job.status = JobStatus.COMPLETED
                job.completed_at = datetime.now(UTC)
                job.lease_until = None
                job.error_message = None
                job.result = result
                if job.job_type in LLM_JOB_TYPES:
                    from app.llm.models import LlmExtractionRun, LlmTaskType

                    run = db.get(LlmExtractionRun, str(job.payload.get("run_id")))
                    if run is not None:
                        queue_llm_stage_completion_check(db, run)
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
                    queue_llm_bulk_completion_check(
                        db,
                        project_id=job.project_id,
                        bulk_id=str(job.payload["bulk_id"]),
                    )
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
                            queue_llm_stage_completion_check(db, run)
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
                    queue_llm_bulk_completion_check(
                        db,
                        project_id=job.project_id,
                        bulk_id=str(job.payload["bulk_id"]),
                    )
                if job.job_type == SEND_EMAIL_JOB:
                    record_email_job_failure(db, job, exc)
                if job.status == JobStatus.FAILED:
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
        "Papertrail worker starting (worker_id=%s, threads=%d, poll_interval=%ss)",
        worker_id,
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
