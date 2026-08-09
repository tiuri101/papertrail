from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.analysis.models import StageAnalysis
from app.analysis.narrative import generate_narrative
from app.analysis.service import compute_stage_stats, compute_stats_fingerprint
from app.jobs.models import BackgroundJob

STAGE_ANALYSIS_JOB = "generate_stage_analysis"


def generate_stage_analysis_job(db: Session, job: BackgroundJob) -> dict[str, Any]:
    if job.project_id is None:
        raise ValueError("generate_stage_analysis job requires a project_id")
    stage = job.payload["stage"]
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
