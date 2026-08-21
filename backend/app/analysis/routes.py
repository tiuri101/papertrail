from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.accounts.dependencies import get_current_user
from app.accounts.models import User
from app.analysis.jobs import STAGE_ANALYSIS_JOB
from app.analysis.models import ResearchQuestionAnalysisRun, StageAnalysis
from app.analysis.reviewer_service import (
    compute_reviewer_analysis,
    compute_reviewer_summary,
)
from app.analysis.rq_jobs import (
    compute_rq_fingerprint,
    latest_successful_run,
    queue_rq_synthesis,
    run_history,
)
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
from app.projects.models import Project, ProjectStage, ResearchQuestion, ScreeningStage
from app.projects.service import require_project_access

router = APIRouter(tags=["analysis"])

_REVIEWER_ANALYSIS_STAGES = {stage.value: stage for stage in ScreeningStage}
_PROJECT_STAGE_INDEX = {
    ProjectStage.DRAFT: 0,
    ProjectStage.DUPLICATE_REVIEW: 1,
    ProjectStage.TITLE_ABSTRACT: 2,
    ProjectStage.FULL_TEXT: 3,
    ProjectStage.EXTRACTION: 4,
    ProjectStage.COMPLETED: 5,
}
_ANALYSIS_AVAILABLE_FROM = {
    "duplicate_review": ProjectStage.TITLE_ABSTRACT,
    "title_abstract_screening": ProjectStage.FULL_TEXT,
    "full_text_screening": ProjectStage.EXTRACTION,
    "extraction_quality": ProjectStage.COMPLETED,
}
_REVIEWER_ANALYSIS_AVAILABLE_FROM = {
    ScreeningStage.TITLE_ABSTRACT: ProjectStage.FULL_TEXT,
    ScreeningStage.FULL_TEXT: ProjectStage.EXTRACTION,
}


def _require_analysis_available(project: Project, available_from: ProjectStage) -> None:
    if _PROJECT_STAGE_INDEX[project.stage] < _PROJECT_STAGE_INDEX[available_from]:
        raise DomainError(
            "Analysis is available only after the corresponding review stage is complete"
        )


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
    project = require_project_access(db, project_id, user)
    if stage not in STAGE_KEYS:
        raise NotFoundError("Unknown analysis stage")
    _require_analysis_available(project, _ANALYSIS_AVAILABLE_FROM[stage])
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


@router.get("/projects/{project_id}/analysis/reviewer-analysis/{stage}")
def reviewer_analysis(
    project_id: str,
    stage: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    project = require_project_access(db, project_id, user)
    screening_stage = _REVIEWER_ANALYSIS_STAGES.get(stage)
    if screening_stage is None:
        raise NotFoundError("Unknown screening stage")
    _require_analysis_available(
        project, _REVIEWER_ANALYSIS_AVAILABLE_FROM[screening_stage]
    )
    analysis = compute_reviewer_analysis(db, project_id, screening_stage)
    return {
        **analysis,
        "reviewerSummary": compute_reviewer_summary(db, project_id),
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
    project = require_project_access(db, project_id, user)
    _require_analysis_available(project, _ANALYSIS_AVAILABLE_FROM[stage])
    if not _narrative_enabled(db, project_id):
        raise DomainError("LLM-generated result analysis is disabled for this project")
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


def _research_question_or_404(
    db: Session, project_id: str, research_question_id: str
) -> ResearchQuestion:
    research_question = db.get(ResearchQuestion, research_question_id)
    if research_question is None or research_question.project_id != project_id:
        raise NotFoundError("Research question not found")
    return research_question


def _serialize_run(run: ResearchQuestionAnalysisRun) -> dict[str, Any]:
    result = run.result or {"statements": [], "limitations": []}
    return {
        "id": run.id,
        "status": run.status,
        "generatedAt": run.completed_at,
        "statements": result.get("statements", []),
        "limitations": result.get("limitations", []),
        "sourceRefs": run.validated_source_refs or {},
        "model": run.model,
        "promptVersion": run.prompt_template_version,
        "error": run.error,
    }


@router.get("/projects/{project_id}/research-questions/{research_question_id}/analysis")
def research_question_analysis(
    project_id: str,
    research_question_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    require_project_access(db, project_id, user)
    research_question = _research_question_or_404(db, project_id, research_question_id)
    synthesis_enabled = _narrative_enabled(db, project_id)
    latest = latest_successful_run(db, research_question_id)
    is_stale = False
    if latest is not None and synthesis_enabled:
        current_fingerprint = compute_rq_fingerprint(db, project_id, research_question)
        is_stale = latest.input_fingerprint != current_fingerprint
    return {
        "researchQuestionId": research_question_id,
        "researchQuestionText": research_question.text,
        "synthesisEnabled": synthesis_enabled,
        "latestRun": _serialize_run(latest) if latest else None,
        "isStale": is_stale,
    }


@router.get(
    "/projects/{project_id}/research-questions/{research_question_id}/analysis/history"
)
def research_question_analysis_history(
    project_id: str,
    research_question_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[dict[str, Any]]:
    require_project_access(db, project_id, user)
    _research_question_or_404(db, project_id, research_question_id)
    return [_serialize_run(run) for run in run_history(db, research_question_id)]


@router.post(
    "/projects/{project_id}/research-questions/{research_question_id}/analysis/regenerate"
)
def regenerate_research_question_analysis(
    project_id: str,
    research_question_id: str,
    user: User = Depends(require_project_member_csrf),
    db: Session = Depends(get_db),
) -> dict[str, str]:
    research_question = _research_question_or_404(db, project_id, research_question_id)
    if not _narrative_enabled(db, project_id):
        raise DomainError("LLM-generated result analysis is disabled for this project")
    run = queue_rq_synthesis(
        db, project_id, research_question, created_by_id=user.id, priority=5
    )
    db.commit()
    return {"jobId": run.background_job_id or "", "runId": run.id}
