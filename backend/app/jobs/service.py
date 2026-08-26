from __future__ import annotations

from datetime import timedelta
from typing import Any

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.core.time import utcnow
from app.jobs.models import BackgroundJob, JobStatus


def enqueue_job(
    db: Session,
    job_type: str,
    payload: dict[str, Any],
    *,
    project_id: str | None,
    created_by_id: str | None,
    max_attempts: int = 3,
    priority: int = 0,
) -> BackgroundJob:
    job = BackgroundJob(
        job_type=job_type,
        payload=payload,
        project_id=project_id,
        created_by_id=created_by_id,
        max_attempts=max_attempts,
        priority=priority,
    )
    db.add(job)
    db.flush()
    return job


def claim_job(
    db: Session,
    worker_id: str,
    lease_seconds: int = 300,
    *,
    allowed_job_types: set[str] | None = None,
    excluded_job_types: set[str] | None = None,
) -> BackgroundJob | None:
    now = utcnow()
    query = (
        select(BackgroundJob)
        .where(
            or_(
                BackgroundJob.status == JobStatus.QUEUED,
                (BackgroundJob.status == JobStatus.RUNNING)
                & (BackgroundJob.lease_until < now),
            ),
            BackgroundJob.attempts < BackgroundJob.max_attempts,
        )
        .order_by(BackgroundJob.priority.desc(), BackgroundJob.created_at)
    )
    if allowed_job_types is not None:
        query = query.where(BackgroundJob.job_type.in_(allowed_job_types))
    if excluded_job_types:
        query = query.where(BackgroundJob.job_type.not_in(excluded_job_types))
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


ABANDONED_JOB_ERROR = (
    "The worker running this job stopped before it finished, and no retry "
    "attempts were left."
)


def reap_abandoned_jobs(db: Session, *, limit: int = 20) -> list[BackgroundJob]:
    """Fail jobs whose worker died without ever recording an outcome.

    A worker killed mid-job leaves the row RUNNING with a lease that simply
    stops being renewed. `claim_job` re-runs such a job while attempts remain,
    but once they are exhausted nothing can claim it again and nothing ever
    marks it finished -- it stays RUNNING forever, and so does any domain
    state that follows it (an ImportBatch stuck in PROCESSING, say). This is
    the only place that terminal state gets written for a crashed worker, so
    it is what makes "job.status is authoritative" true in practice.

    Rows are locked with SKIP LOCKED on PostgreSQL so concurrent workers can
    each reap a disjoint slice instead of contending.
    """
    now = utcnow()
    query = (
        select(BackgroundJob)
        .where(
            BackgroundJob.status == JobStatus.RUNNING,
            BackgroundJob.lease_until.is_not(None),
            BackgroundJob.lease_until < now,
            BackgroundJob.attempts >= BackgroundJob.max_attempts,
        )
        .order_by(BackgroundJob.lease_until)
        .limit(limit)
    )
    if db.bind is not None and db.bind.dialect.name == "postgresql":
        query = query.with_for_update(skip_locked=True)
    abandoned = list(db.scalars(query))
    for job in abandoned:
        job.status = JobStatus.FAILED
        job.completed_at = now
        job.lease_until = None
        job.error_message = job.error_message or ABANDONED_JOB_ERROR
    db.flush()
    return abandoned


def restart_job(db: Session, job: BackgroundJob) -> None:
    job.status = JobStatus.QUEUED
    job.attempts = 0
    job.error_message = None
    job.result = None
    job.started_at = None
    job.completed_at = None
    job.lease_until = None
    job.locked_by = None
    job.progress_current = 0
    job.progress_total = 0
    job.progress_message = None
    db.flush()


def renew_job_lease(
    db: Session,
    job_id: str,
    worker_id: str,
    lease_seconds: int,
) -> bool:
    job = db.get(BackgroundJob, job_id)
    if job is None or job.status != JobStatus.RUNNING or job.locked_by != worker_id:
        return False
    job.lease_until = utcnow() + timedelta(seconds=lease_seconds)
    db.commit()
    return True
