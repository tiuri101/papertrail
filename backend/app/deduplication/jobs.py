from sqlalchemy.orm import Session

from app.deduplication.service import (
    detect_duplicates,
    transition_if_duplicate_review_complete,
)
from app.jobs.models import BackgroundJob
from app.projects.service import get_project


def detect_duplicates_job(db: Session, job: BackgroundJob) -> dict:
    project_id = job.payload["project_id"]
    count = detect_duplicates(db, project_id)
    transition_if_duplicate_review_complete(db, get_project(db, project_id))
    db.commit()
    return {"projectId": project_id, "candidates": count}
