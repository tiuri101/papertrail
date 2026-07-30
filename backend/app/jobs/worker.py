from __future__ import annotations

import logging
import signal
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from threading import Event, Thread

from sqlalchemy.orm import Session, sessionmaker

from app.audit.service import record_audit
from app.core.config import get_settings
from app.core.logging import configure_logging
from app.db import models as _models  # noqa: F401  # registers all SQLAlchemy models
from app.db.session import SessionFactory
from app.deduplication.jobs import detect_duplicates_job
from app.imports.service import process_import_job
from app.jobs.models import BackgroundJob, JobStatus
from app.jobs.service import claim_job, renew_job_lease
from app.publications.jobs import enrich_publication_job
from app.reporting.jobs import generate_export_job

logger = logging.getLogger(__name__)
Handler = Callable[[Session, BackgroundJob], dict]
HANDLERS: dict[str, Handler] = {
    "parse_import": process_import_job,
    "enrich_publication": enrich_publication_job,
    "detect_duplicates": detect_duplicates_job,
    "generate_export": generate_export_job,
}


def maintain_lease(
    session_factory: sessionmaker,
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


def execute_next_job(session_factory: sessionmaker, worker_id: str) -> bool:
    settings = get_settings()
    try:
        with session_factory() as claim_session:
            job = claim_job(claim_session, worker_id, settings.job_lease_seconds)
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
                job.result = result
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
                db.rollback()
                job = db.get(BackgroundJob, job_id)
                assert job is not None
                job.status = (
                    JobStatus.QUEUED
                    if job.attempts < job.max_attempts
                    else JobStatus.FAILED
                )
                job.error_message = str(exc)
                job.lease_until = None
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
                logger.exception("Background job %s failed", job_id)
            return True
    finally:
        lease_stop.set()
        heartbeat.join(timeout=2)


def run_worker() -> None:
    configure_logging()
    settings = get_settings()
    stop = Event()
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    worker_id = f"worker-{id(stop)}"
    logger.info(
        "Papertrail worker starting (worker_id=%s, threads=%d, poll_interval=%ss)",
        worker_id,
        settings.worker_threads,
        settings.job_poll_interval_seconds,
    )
    with ThreadPoolExecutor(
        max_workers=settings.worker_threads,
        thread_name_prefix="papertrail",
    ) as executor:
        futures = set()
        while not stop.is_set():
            futures = {future for future in futures if not future.done()}
            available = settings.worker_threads - len(futures)
            for _ in range(available):
                futures.add(
                    executor.submit(execute_next_job, SessionFactory, worker_id)
                )
            stop.wait(settings.job_poll_interval_seconds)


if __name__ == "__main__":
    run_worker()
