from typing import Any

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.accounts.dependencies import get_current_user
from app.accounts.models import User
from app.api.errors import NotFoundError
from app.db.session import get_db
from app.imports.schemas import JobErrorResponse, JobResponse
from app.jobs.diagnostics import build_job_diagnostics
from app.jobs.models import BackgroundJob
from app.projects.service import require_project_access

router = APIRouter(prefix="/jobs", tags=["jobs"])


@router.get("/{job_id}", response_model=JobResponse)
def get_job(
    job_id: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)
) -> BackgroundJob:
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
    job = db.get(BackgroundJob, job_id)
    if job is None:
        raise NotFoundError("Job not found")
    if job.project_id:
        require_project_access(db, job.project_id, user)
    result = job.result if isinstance(job.result, dict) else {}
    return {
        "job_id": job.id,
        "job_type": job.job_type,
        "project_id": job.project_id,
        "attempt": job.attempts,
        "max_attempts": job.max_attempts,
        "queued_at": job.created_at,
        "started_at": job.started_at,
        "failed_at": job.completed_at,
        "error_type": result.get("errorType"),
        "error_message": job.error_message,
        "error_details": result.get("errorDetails"),
        **build_job_diagnostics(db, job),
    }
