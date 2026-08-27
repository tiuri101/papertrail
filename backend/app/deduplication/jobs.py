from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.deduplication.assessment import assess_duplicate_candidates
from app.deduplication.models import DuplicateCandidate
from app.deduplication.service import (
    detect_duplicates,
    transition_if_duplicate_review_complete,
)
from app.jobs.errors import TransientJobError
from app.jobs.models import BackgroundJob, JobStatus
from app.jobs.service import enqueue_job
from app.projects.models import ProjectStage
from app.projects.service import get_project


def _queue_candidate_assessment(
    db: Session, project_id: str, created_by_id: str | None
) -> str | None:
    """Enqueue the external-provider assist for the unresolved candidates a
    detection run just produced -- unless it is switched off, there is nothing
    left to assess, or an assessment job is already pending."""
    if not get_settings().duplicate_assessment_enabled:
        return None
    unresolved = (
        db.scalar(
            select(func.count())
            .select_from(DuplicateCandidate)
            .where(
                DuplicateCandidate.project_id == project_id,
                DuplicateCandidate.status == "unresolved",
            )
        )
        or 0
    )
    if not unresolved:
        return None
    already_queued = db.scalar(
        select(BackgroundJob.id).where(
            BackgroundJob.project_id == project_id,
            BackgroundJob.job_type == "assess_duplicate_candidates",
            BackgroundJob.status.in_([JobStatus.QUEUED, JobStatus.RUNNING]),
        )
    )
    if already_queued is not None:
        return None
    job = enqueue_job(
        db,
        "assess_duplicate_candidates",
        {"project_id": project_id},
        project_id=project_id,
        created_by_id=created_by_id,
    )
    return job.id


def detect_duplicates_job(db: Session, job: BackgroundJob) -> dict[str, Any]:
    project_id = job.payload["project_id"]
    count = detect_duplicates(db, project_id)
    project = get_project(db, project_id)
    transition_if_duplicate_review_complete(db, project)
    assessment_job_id: str | None = None
    if project.stage == ProjectStage.DUPLICATE_REVIEW:
        assessment_job_id = _queue_candidate_assessment(
            db, project_id, job.created_by_id
        )
    db.commit()
    return {
        "projectId": project_id,
        "candidates": count,
        "assessmentJobId": assessment_job_id,
    }


def assess_duplicate_candidates_job(
    db: Session, job: BackgroundJob
) -> dict[str, Any]:
    """Check candidate-record URLs and ask Crossref / Semantic Scholar which
    record to keep (auto-merging a provider-confirmed same-work pair).

    Re-running is safe: it only touches candidates still ``unresolved``,
    upserts one URL-check row per (publication, kind), and overwrites the
    recommendation columns -- a retry converges. If every provider call and
    every URL probe failed transiently and nothing was learned, the job fails
    so the worker retries rather than reporting an assessment that never
    happened.
    """
    project_id = job.payload["project_id"]
    result = assess_duplicate_candidates(db, project_id)
    if (
        result["transientFailure"]
        and result["autoMerged"] == 0
        and result["recommended"] == 0
        and result["inconclusive"] == 0
        and result["urlVerdicts"] == 0
    ):
        raise TransientJobError(
            "No metadata provider or bibliographic URL could be reached to "
            "assess duplicate candidates"
        )
    db.commit()
    return {"projectId": project_id, **result}
