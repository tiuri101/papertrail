from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.analysis.models import StageAnalysis
from app.analysis.narrative import generate_narrative
from app.analysis.service import compute_stage_stats, compute_stats_fingerprint
from app.jobs.models import BackgroundJob, JobStatus
from app.llm.installation_settings import effective_llm_settings

STAGE_ANALYSIS_JOB = "generate_stage_analysis"


def cancel_queued_stage_analysis_jobs(db: Session) -> int:
    """Stop queued narrative jobs when LLM support is disabled installation-wide.

    A job already claimed and running is left alone; it re-checks the
    installation setting itself right before calling Ollama (see
    ``generate_stage_analysis_job``) and skips without writing a result.
    """
    jobs = list(
        db.scalars(
            select(BackgroundJob).where(
                BackgroundJob.job_type == STAGE_ANALYSIS_JOB,
                BackgroundJob.status == JobStatus.QUEUED,
            )
        )
    )
    now = datetime.now(UTC)
    for job in jobs:
        job.status = JobStatus.CANCELLED
        job.completed_at = now
    db.flush()
    return len(jobs)


def generate_stage_analysis_job(db: Session, job: BackgroundJob) -> dict[str, Any]:
    if job.project_id is None:
        raise ValueError("generate_stage_analysis job requires a project_id")
    stage = job.payload["stage"]
    if not effective_llm_settings(db).llm_enabled:
        return {"stage": stage, "status": "skipped", "reason": "llm_disabled"}
    stats = compute_stage_stats(db, job.project_id, stage)
    fingerprint = compute_stats_fingerprint(stats)
    summary = generate_narrative(stage, stats)

    existing = db.scalar(
        select(StageAnalysis).where(
            StageAnalysis.project_id == job.project_id,
            StageAnalysis.stage == stage,
        )
    )
    generated_at = datetime.now(UTC)
    if existing is not None:
        existing.summary = summary
        existing.stats_fingerprint = fingerprint
        existing.generated_at = generated_at
    else:
        db.add(
            StageAnalysis(
                project_id=job.project_id,
                stage=stage,
                summary=summary,
                stats_fingerprint=fingerprint,
                generated_at=generated_at,
            )
        )
    db.flush()
    return {"stage": stage, "summary": summary}
