from typing import Any

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.accounts.dependencies import get_current_user
from app.accounts.models import User
from app.api.errors import ForbiddenError, NotFoundError
from app.db.session import get_db
from app.jobs.diagnostics import build_job_diagnostics
from app.jobs.models import BackgroundJob
from app.jobs.sanitize import (
    diagnostic_error_details,
    error_type,
    public_error_message,
)
from app.jobs.schemas import JobErrorResponse, JobResponse
from app.projects.service import is_project_manager, require_project_access

router = APIRouter(prefix="/jobs", tags=["jobs"])


@router.get("/{job_id}", response_model=JobResponse)
def get_job(
    job_id: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)
) -> BackgroundJob:
    """The ordinary job view -- available to every project member.

    ``JobResponse`` redacts the failure diagnostics itself, so the raw
    traceback stored in ``job.result`` never leaves through this route.
    """
    job = db.get(BackgroundJob, job_id)
    if job is None:
        raise NotFoundError("Job not found")
    if job.project_id:
        require_project_access(db, job.project_id, user)
    return job


@router.get("/{job_id}/error", response_model=JobErrorResponse)
def get_job_error(
    job_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    """The privileged diagnostics endpoint.

    Deliberately the *only* place a raw traceback and an unredacted
    exception message are served, and only to a global administrator or a
    manager of the job's project. An ordinary member still gets the safe
    error category, redacted message and failure context so they can tell
    what broke and ask for help -- but no stack frames, deployment paths,
    SQL or internal hostnames.
    """
    job = db.get(BackgroundJob, job_id)
    if job is None:
        raise NotFoundError("Job not found")
    if job.project_id:
        require_project_access(db, job.project_id, user)
        can_view_details = user.is_admin or is_project_manager(db, job.project_id, user)
    else:
        if not user.is_admin:
            raise ForbiddenError("Administrator access required")
        can_view_details = True
    return {
        "job_id": job.id,
        "job_type": job.job_type,
        "project_id": job.project_id,
        "attempt": job.attempts,
        "max_attempts": job.max_attempts,
        "queued_at": job.created_at,
        "started_at": job.started_at,
        "failed_at": job.completed_at,
        "error_type": error_type(job.result),
        "error_message": (
            job.error_message
            if can_view_details
            else public_error_message(job.error_message)
        ),
        "error_details": (
            diagnostic_error_details(job.result) if can_view_details else None
        ),
        **build_job_diagnostics(db, job),
    }
