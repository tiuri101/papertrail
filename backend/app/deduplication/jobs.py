from sqlalchemy.orm import Session
from app.deduplication.service import detect_duplicates
from app.jobs.models import BackgroundJob

def detect_duplicates_job(db: Session, job: BackgroundJob) -> dict:
    count = detect_duplicates(db, job.payload["project_id"])
    db.commit()
    return {"projectId": job.payload["project_id"], "candidates": count}
