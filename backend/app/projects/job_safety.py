"""One safety gate for every destructive project-lifecycle operation.

Delete Project, Reset Project, Move Back and Undo Merge all rewind or erase
workflow state that a background handler may be in the middle of writing to.
A handler runs in its own session and its own transaction: it re-reads the
rows it needs and commits them long after the request that enqueued it
returned.  Nothing in the job protocol makes those writes conditional on the
project still being in the shape the job was queued for, so a lifecycle
operation that lands between a handler's read and its commit re-materializes
publications, work items or decisions the operation had just deleted -- and
the project ends up in a state no reviewer action could have produced.

Deleting a *running* job's row does not help either: the handler is already
executing, holds the job id in memory, and will happily commit its domain
writes afterwards.  The only sound answer for a job that has already started
is to wait for it.

The policy this module applies, uniformly:

* **RUNNING** -- refuse the lifecycle operation.  The work is in flight and
  cannot be recalled; the caller is told to wait.
* **QUEUED** -- cancel it.  Nothing has started, so cancelling is safe, and
  it is the only way an operation can ever proceed: a queued job for a
  project being reset would otherwise either run against wiped state or
  block the reset indefinitely.
* Everything terminal (COMPLETED / FAILED / CANCELLED) -- ignored.  Those
  jobs are finished and cannot write anything.

The check is deliberately project-wide rather than per-stage.  Deciding which
job types are "affected" by a rewind to a particular stage means duplicating,
in this module, knowledge of what every handler writes -- and getting it
wrong fails open.  Every job type registered today writes something a
destructive rewind touches (publications, duplicate candidates, LLM runs,
analyses, exports, notifications about stages), so the conservative rule
costs nothing real and cannot silently miss a case when a new job type is
added.

Lock ordering: rows are locked FOR UPDATE here before any lifecycle mutation
runs, which keeps this at the front of the project-wide
Project -> Publication -> work item ordering.
"""

from __future__ import annotations

import enum

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.errors import ConflictError
from app.core.time import utcnow
from app.jobs.models import BackgroundJob, JobStatus


class LifecycleOperation(enum.StrEnum):
    """The destructive operations this gate protects."""

    DELETE = "delete"
    RESET = "reset"
    MOVE_BACK = "move_back"
    UNDO_MERGE = "undo_merge"


# Phrased to complete "Wait for running background jobs to finish before ...".
_OPERATION_PHRASES: dict[LifecycleOperation, str] = {
    LifecycleOperation.DELETE: "deleting the project",
    LifecycleOperation.RESET: "resetting the project",
    LifecycleOperation.MOVE_BACK: "moving the project back",
    LifecycleOperation.UNDO_MERGE: "undoing this merge",
}

CANCELLED_BY_LIFECYCLE = (
    "Cancelled: a project lifecycle operation removed the work this job "
    "was queued for."
)


class ProjectJobsRunningError(ConflictError):
    """A lifecycle operation was attempted while a handler is still running.

    409 rather than 400: the request is well-formed and will succeed once the
    job finishes.  Carries a distinct code plus the running job types so a
    client can show *what* to wait for and offer a retry, instead of a
    generic conflict.
    """

    code = "project_jobs_running"

    def __init__(
        self, operation: LifecycleOperation, jobs: list[BackgroundJob]
    ) -> None:
        super().__init__(
            "Wait for running background jobs to finish before "
            f"{_OPERATION_PHRASES[operation]}",
            details={
                "operation": operation.value,
                "runningJobCount": len(jobs),
                "runningJobTypes": sorted({job.job_type for job in jobs}),
            },
        )
        self.operation = operation


def guard_lifecycle_jobs(
    db: Session, project_id: str, *, operation: LifecycleOperation
) -> int:
    """Make it safe to rewind this project's workflow state, or refuse.

    Locks the project's unfinished jobs so a worker cannot claim one while
    the decision is being made, raises
    :class:`ProjectJobsRunningError` if any is already RUNNING, and cancels
    the QUEUED ones otherwise.  Returns how many queued jobs were cancelled
    so callers can report it.

    Must be called *before* the operation's first mutation, inside the same
    transaction: the FOR UPDATE locks are only held until that transaction
    commits, and it is that overlap which keeps a job from being claimed
    between the check and the wipe.
    """
    query = select(BackgroundJob).where(
        BackgroundJob.project_id == project_id,
        BackgroundJob.status.in_([JobStatus.QUEUED, JobStatus.RUNNING]),
    )
    if db.bind is not None and db.bind.dialect.name == "postgresql":
        query = query.with_for_update()
    unfinished = list(db.scalars(query))

    running = [job for job in unfinished if job.status == JobStatus.RUNNING]
    if running:
        raise ProjectJobsRunningError(operation, running)

    now = utcnow()
    for job in unfinished:
        job.status = JobStatus.CANCELLED
        job.completed_at = now
        job.lease_until = None
        job.error_message = job.error_message or CANCELLED_BY_LIFECYCLE
    db.flush()
    return len(unfinished)
