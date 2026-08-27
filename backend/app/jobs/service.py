from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta
from typing import Any

from sqlalchemy import ColumnElement, case, func, nulls_last, or_, select, update
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


# The two states a job can be cancelled out of: it has not finished, so there
# is a reviewer decision to make about whether it should. COMPLETED / FAILED /
# already-CANCELLED jobs are terminal and left alone.
CANCELLABLE_STATUSES = (JobStatus.QUEUED, JobStatus.RUNNING)


def cancel_project_jobs(db: Session, project_id: str) -> list[BackgroundJob]:
    """Cancel every unfinished background job belonging to ``project_id``.

    A QUEUED job is stopped outright -- ``claim_job`` only ever looks at
    QUEUED (or lease-expired RUNNING) rows, so a cancelled one is never
    picked up. A RUNNING job cannot be interrupted mid-handler; it is
    marked CANCELLED here and ``execute_next_job`` notices when the handler
    returns, discards whatever it produced and does not retry it.

    The status guard lives in the UPDATE's WHERE clause so a job the worker
    committed as COMPLETED/FAILED in the same instant is not dragged back to
    CANCELLED.
    """
    pending_ids = list(
        db.scalars(
            select(BackgroundJob.id).where(
                BackgroundJob.project_id == project_id,
                BackgroundJob.status.in_(CANCELLABLE_STATUSES),
            )
        )
    )
    if not pending_ids:
        return []
    now = utcnow()
    db.execute(
        update(BackgroundJob)
        .where(
            BackgroundJob.id.in_(pending_ids),
            BackgroundJob.status.in_(CANCELLABLE_STATUSES),
        )
        .values(status=JobStatus.CANCELLED, completed_at=now, lease_until=None)
        .execution_options(synchronize_session=False)
    )
    db.expire_all()
    return list(
        db.scalars(
            select(BackgroundJob)
            .where(
                BackgroundJob.id.in_(pending_ids),
                BackgroundJob.status == JobStatus.CANCELLED,
            )
            .order_by(BackgroundJob.created_at.desc(), BackgroundJob.id.asc())
        )
    )


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


DEFAULT_JOB_PAGE_SIZE = 25
MAX_JOB_PAGE_SIZE = 200

# The camelCase keys the Jobs page column headers sort by. Kept in the API's
# own vocabulary so the query string matches what the client sends verbatim.
JOB_SORT_KEYS: tuple[str, ...] = (
    "jobType",
    "status",
    "progress",
    "message",
    "createdAt",
    "completedAt",
)


@dataclass(frozen=True)
class JobPage:
    """One page of a project's background jobs, plus the aggregates the client
    used to derive from holding the whole list.

    ``total`` counts the rows matching the request's filters; ``project_total``,
    ``status_counts`` and ``job_types`` ignore them and describe the project as
    a whole (what the status summary cards and the job-type dropdown show).
    ``failed_ids`` is every failed job in the project, so "Restart all failed"
    still spans pages.
    """

    items: list[BackgroundJob]
    total: int
    project_total: int
    page: int
    page_size: int
    page_count: int
    has_more: bool
    status_counts: dict[str, int]
    job_types: list[str]
    failed_ids: list[str]


def _job_sort_expression(key: str) -> Any:
    if key == "jobType":
        return func.lower(BackgroundJob.job_type)
    if key == "status":
        return BackgroundJob.status
    if key == "progress":
        # The fraction complete; a job with no known total has no position on
        # this axis and sorts last in either direction (see ``nulls_last``).
        return case(
            (BackgroundJob.progress_total == 0, None),
            else_=BackgroundJob.progress_current * 1.0 / BackgroundJob.progress_total,
        )
    if key == "message":
        return func.lower(
            func.coalesce(
                BackgroundJob.error_message, BackgroundJob.progress_message, ""
            )
        )
    if key == "completedAt":
        return BackgroundJob.completed_at
    return BackgroundJob.created_at


def _job_order_by(sort: str, direction: str) -> list[Any]:
    """A total order, so consecutive pages cannot overlap or skip rows.

    ``status`` and ``jobType`` are far from unique, so a bare sort on either
    lets the database return ties in a different order per page. ``created_at``
    then ``id`` settles every tie deterministically.
    """
    chosen = _job_sort_expression(sort)
    primary = chosen.desc() if direction == "desc" else chosen.asc()
    return [
        nulls_last(primary),
        BackgroundJob.created_at.desc(),
        BackgroundJob.id.asc(),
    ]


def _job_count(db: Session, clauses: list[ColumnElement[bool]]) -> int:
    return int(
        db.scalar(
            select(func.count()).select_from(BackgroundJob).where(*clauses)
        )
        or 0
    )


def jobs_page(
    db: Session,
    project_id: str,
    *,
    status: JobStatus | None = None,
    job_type: str | None = None,
    sort: str = "createdAt",
    direction: str = "desc",
    page: int = 1,
    page_size: int = DEFAULT_JOB_PAGE_SIZE,
) -> JobPage:
    """One page of ``project_id``'s background jobs, newest first by default."""
    page_size = max(1, min(page_size, MAX_JOB_PAGE_SIZE))
    page = max(1, page)
    if sort not in JOB_SORT_KEYS:
        sort = "createdAt"
    if direction not in ("asc", "desc"):
        direction = "desc"

    scope: list[ColumnElement[bool]] = [BackgroundJob.project_id == project_id]
    filtered = list(scope)
    if status is not None:
        filtered.append(BackgroundJob.status == status)
    if job_type:
        filtered.append(BackgroundJob.job_type == job_type)

    total = _job_count(db, filtered)
    project_total = _job_count(db, scope)

    status_counts = {member.value: 0 for member in JobStatus}
    for job_status, count in db.execute(
        select(BackgroundJob.status, func.count())
        .where(*scope)
        .group_by(BackgroundJob.status)
    ).all():
        status_counts[JobStatus(job_status).value] = int(count)

    job_types = list(
        db.scalars(
            select(BackgroundJob.job_type)
            .where(*scope)
            .group_by(BackgroundJob.job_type)
            .order_by(BackgroundJob.job_type)
        )
    )

    failed_ids = list(
        db.scalars(
            select(BackgroundJob.id)
            .where(*scope, BackgroundJob.status == JobStatus.FAILED)
            .order_by(BackgroundJob.created_at.desc(), BackgroundJob.id.asc())
        )
    )

    items = list(
        db.scalars(
            select(BackgroundJob)
            .where(*filtered)
            .order_by(*_job_order_by(sort, direction))
            .limit(page_size)
            .offset((page - 1) * page_size)
        )
    )
    page_count = max(1, -(-total // page_size))
    return JobPage(
        items=items,
        total=total,
        project_total=project_total,
        page=page,
        page_size=page_size,
        page_count=page_count,
        has_more=page < page_count,
        status_counts=status_counts,
        job_types=job_types,
        failed_ids=failed_ids,
    )
