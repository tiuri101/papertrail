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
from app.api.errors import DomainError, NotFoundError
from app.db.session import get_db
from app.jobs.service import enqueue_job
from app.llm.installation_settings import effective_llm_settings
from app.llm.schema_service import project_settings
from app.projects.dependencies import require_project_member_csrf
from app.projects.service import require_project_access

router = APIRouter(tags=["analysis"])


def _narrative_enabled(db: Session, project_id: str) -> bool:
    if not effective_llm_settings(db).llm_enabled:
        return False
    settings = project_settings(db, project_id)
    return settings.analysis_narrative_enabled if settings is not None else True


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
    narrative_enabled = _narrative_enabled(db, project_id)
    narrative = None
    is_stale = True
    if narrative_enabled:
        analysis = db.scalar(
            select(StageAnalysis).where(
                StageAnalysis.project_id == project_id, StageAnalysis.stage == stage
            )
        )
        if analysis is not None:
            narrative = {
                "summary": analysis.summary,
                "generatedAt": analysis.generated_at,
            }
            is_stale = analysis.stats_fingerprint != fingerprint
    return {
        "stats": stats,
        "narrative": narrative,
        "isStale": is_stale,
        "narrativeEnabled": narrative_enabled,
    }


@router.post("/projects/{project_id}/analysis/{stage}/regenerate")
def regenerate_stage_analysis(
    project_id: str,
    stage: str,
    user: User = Depends(require_project_member_csrf),
    db: Session = Depends(get_db),
) -> dict[str, str]:
    if stage not in STAGE_KEYS:
        raise NotFoundError("Unknown analysis stage")
    if not _narrative_enabled(db, project_id):
        raise DomainError(
            "LLM-generated result analysis is disabled for this project"
        )
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
