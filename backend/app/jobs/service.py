from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.jobs.models import BackgroundJob, JobStatus


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def enqueue_job(db: Session, job_type: str, payload: dict[str, Any], *, project_id: str | None, created_by_id: str | None, max_attempts: int = 3) -> BackgroundJob:
    job = BackgroundJob(job_type=job_type, payload=payload, project_id=project_id, created_by_id=created_by_id, max_attempts=max_attempts)
    db.add(job)
    db.flush()
    return job


def claim_job(db: Session, worker_id: str, lease_seconds: int = 300) -> BackgroundJob | None:
    now = utcnow()
    query = select(BackgroundJob).where(
        or_(
            BackgroundJob.status == JobStatus.QUEUED,
            (BackgroundJob.status == JobStatus.RUNNING) & (BackgroundJob.lease_until < now),
        ),
        BackgroundJob.attempts < BackgroundJob.max_attempts,
    ).order_by(BackgroundJob.created_at)
    if db.bind is not None and db.bind.dialect.name == "postgresql":
        query = query.with_for_update(skip_locked=True)
    job = db.scalar(query.limit(1))
    if job is None:
        return None
    job.status = JobStatus.RUNNING
    job.locked_by = worker_id
    job.lease_until = now + timedelta(seconds=lease_seconds)
    job.started_at = job.started_at or now
    job.attempts += 1
    db.flush()
    return job


def update_progress(db: Session, job: BackgroundJob, current: int, total: int, message: str) -> None:
    job.progress_current = current
    job.progress_total = total
    job.progress_message = message
    db.commit()


def renew_job_lease(
    db: Session,
    job_id: str,
    worker_id: str,
    lease_seconds: int,
) -> bool:
    job = db.get(BackgroundJob, job_id)
    if (
        job is None
        or job.status != JobStatus.RUNNING
        or job.locked_by != worker_id
    ):
        return False
    job.lease_until = utcnow() + timedelta(seconds=lease_seconds)
    db.commit()
    return True
