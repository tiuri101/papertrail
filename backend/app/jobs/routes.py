from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.accounts.dependencies import get_current_user
from app.accounts.models import User
from app.api.errors import NotFoundError
from app.db.session import get_db
from app.imports.schemas import JobResponse
from app.jobs.models import BackgroundJob
from app.projects.service import require_project_access

router = APIRouter(prefix="/jobs", tags=["jobs"])


@router.get("/{job_id}", response_model=JobResponse)
def get_job(job_id: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    job = db.get(BackgroundJob, job_id)
    if job is None:
        raise NotFoundError("Job not found")
    if job.project_id:
        require_project_access(db, job.project_id, user)
    return job
