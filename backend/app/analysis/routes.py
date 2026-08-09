from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.accounts.dependencies import get_current_user
from app.accounts.models import User
from app.analysis.jobs import STAGE_ANALYSIS_JOB
from app.analysis.models import StageAnalysis
from app.analysis.service import (
    STAGE_KEYS,
    compute_stage_stats,
    compute_stats_fingerprint,
)
from app.api.errors import NotFoundError
from app.db.session import get_db
from app.jobs.service import enqueue_job
from app.projects.dependencies import require_project_member_csrf
from app.projects.service import require_project_access

router = APIRouter(tags=["analysis"])


@router.get("/projects/{project_id}/analysis/{stage}")
def project_stage_analysis(
    project_id: str,
    stage: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    require_project_access(db, project_id, user)
    if stage not in STAGE_KEYS:
        raise NotFoundError("Unknown analysis stage")
    stats = compute_stage_stats(db, project_id, stage)
    fingerprint = compute_stats_fingerprint(stats)
    analysis = db.scalar(
        select(StageAnalysis).where(
            StageAnalysis.project_id == project_id, StageAnalysis.stage == stage
        )
    )
    narrative = None
    is_stale = True
    if analysis is not None:
        narrative = {"summary": analysis.summary, "generatedAt": analysis.generated_at}
        is_stale = analysis.stats_fingerprint != fingerprint
    return {"stats": stats, "narrative": narrative, "isStale": is_stale}


@router.post("/projects/{project_id}/analysis/{stage}/regenerate")
def regenerate_stage_analysis(
    project_id: str,
    stage: str,
    user: User = Depends(require_project_member_csrf),
    db: Session = Depends(get_db),
) -> dict[str, str]:
    if stage not in STAGE_KEYS:
        raise NotFoundError("Unknown analysis stage")
    job = enqueue_job(
        db,
        STAGE_ANALYSIS_JOB,
        {"stage": stage},
        project_id=project_id,
        created_by_id=user.id,
        priority=5,
    )
    db.commit()
    return {"jobId": job.id}
