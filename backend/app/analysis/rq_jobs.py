"""Job glue for RQ synthesis: colocated with ``ResearchQuestionAnalysisRun``,
mirroring ``analysis/jobs.py``'s ``STAGE_ANALYSIS_JOB`` precedent -- but,
unlike that job, this one makes real Ollama calls (potentially several per
research question) and so belongs on the dedicated ``--llm`` worker pool via
``LLM_JOB_TYPES``.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.analysis.models import ResearchQuestionAnalysisRun
from app.api.errors import DomainError
from app.audit.service import record_audit
from app.jobs.errors import TransientJobError
from app.jobs.models import BackgroundJob, JobStatus
from app.jobs.service import enqueue_job
from app.llm.installation_settings import effective_llm_settings
from app.llm.ollama import (
    OllamaResponseError,
    OllamaTransientError,
    with_attempt_sampling,
)
from app.llm.rq_prompt import RQ_SYNTHESIS_PROMPT_VERSION
from app.llm.rq_synthesis import run_rq_synthesis
from app.llm.task_service import fingerprint
from app.projects.models import ResearchQuestion
from app.reporting.evidence_dataset import build_evidence_dataset

RQ_SYNTHESIS_JOB = "generate_rq_synthesis"


def compute_rq_fingerprint(
    db: Session, project_id: str, research_question: ResearchQuestion
) -> str:
    dataset = build_evidence_dataset(db, project_id)
    config = effective_llm_settings(db)
    model = config.ollama_model if config.llm_enabled else None
    facts_payload = {
        publication.id: {
            key: {
                "value": fact.value,
                "state": fact.state,
                "versionRef": fact.version_ref,
            }
            for key, fact in dataset.facts_for(publication.id).items()
        }
        for publication in dataset.publications
    }
    field_meta = [
        {
            "id": item.id,
            "stableKey": item.stable_key,
            "label": item.label,
            "type": item.field_type.value,
        }
        for item in [*dataset.extraction_fields, *dataset.quality_fields]
    ]
    return fingerprint(
        {
            "prompt": RQ_SYNTHESIS_PROMPT_VERSION,
            "model": model,
            "researchQuestionText": research_question.text,
            "cohort": sorted(publication.id for publication in dataset.publications),
            "facts": facts_payload,
            "fields": field_meta,
        }
    )


def latest_run(
    db: Session, research_question_id: str
) -> ResearchQuestionAnalysisRun | None:
    return db.scalar(
        select(ResearchQuestionAnalysisRun)
        .where(ResearchQuestionAnalysisRun.research_question_id == research_question_id)
        .order_by(ResearchQuestionAnalysisRun.created_at.desc())
    )


def latest_successful_run(
    db: Session, research_question_id: str
) -> ResearchQuestionAnalysisRun | None:
    return db.scalar(
        select(ResearchQuestionAnalysisRun)
        .where(
            ResearchQuestionAnalysisRun.research_question_id == research_question_id,
            ResearchQuestionAnalysisRun.status == "completed",
        )
        .order_by(ResearchQuestionAnalysisRun.created_at.desc())
    )


def run_history(
    db: Session, research_question_id: str
) -> list[ResearchQuestionAnalysisRun]:
    return list(
        db.scalars(
            select(ResearchQuestionAnalysisRun)
            .where(
                ResearchQuestionAnalysisRun.research_question_id == research_question_id
            )
            .order_by(ResearchQuestionAnalysisRun.created_at.desc())
        )
    )


def queue_rq_synthesis(
    db: Session,
    project_id: str,
    research_question: ResearchQuestion,
    *,
    created_by_id: str | None,
    priority: int = 5,
) -> ResearchQuestionAnalysisRun:
    config = effective_llm_settings(db)
    if not config.llm_enabled or not config.ollama_model:
        raise DomainError("LLM support is not configured")
    current_fingerprint = compute_rq_fingerprint(db, project_id, research_question)
    existing = latest_run(db, research_question.id)
    if (
        existing is not None
        and existing.input_fingerprint == current_fingerprint
        and existing.status in {"pending", "processing", "completed"}
    ):
        if existing.background_job_id:
            job = db.get(BackgroundJob, existing.background_job_id)
            if (
                job is not None
                and job.status == JobStatus.QUEUED
                and job.priority < priority
            ):
                job.priority = priority
        return existing
    run = ResearchQuestionAnalysisRun(
        project_id=project_id,
        research_question_id=research_question.id,
        research_question_text=research_question.text,
        input_fingerprint=current_fingerprint,
        provider="ollama",
        model=config.ollama_model,
        model_configuration={
            "temperature": 0,
            "think": False,
            "contextLength": config.llm_context_length,
        },
        prompt_template_version=RQ_SYNTHESIS_PROMPT_VERSION,
        status="pending",
        queued_at=datetime.now(UTC),
    )
    db.add(run)
    db.flush()
    job = enqueue_job(
        db,
        RQ_SYNTHESIS_JOB,
        {"rq_run_id": run.id},
        project_id=project_id,
        created_by_id=created_by_id,
        max_attempts=3,
        priority=priority,
    )
    run.background_job_id = job.id
    record_audit(
        db,
        action="rq_analysis.queued",
        entity_type="research_question_analysis_run",
        entity_id=run.id,
        project_id=project_id,
        actor_id=created_by_id,
        summary="Queued research-question synthesis",
        metadata={"researchQuestionId": research_question.id},
    )
    db.flush()
    return run


def rq_run_was_cancelled(db: Session, run: ResearchQuestionAnalysisRun) -> bool:
    """Re-check a run's status from the database right before persisting a
    result, mirroring ``task_service.was_cancelled`` -- the (possibly
    minutes-long) Ollama call runs after the transaction that set
    ``processing`` is committed, so a concurrent installation-wide LLM
    disable can mark the run cancelled meanwhile."""
    db.refresh(run, attribute_names=["status"])
    return run.status == "cancelled"


def cancel_queued_rq_synthesis_jobs(db: Session) -> int:
    """Stop queued/in-flight RQ synthesis when LLM support is disabled
    installation-wide, mirroring ``cancel_queued_stage_analysis_jobs``. A job
    already ``PROCESSING`` is left alone; the worker discards its result via
    ``rq_run_was_cancelled`` right before persisting.
    """
    jobs = list(
        db.scalars(
            select(BackgroundJob).where(
                BackgroundJob.job_type == RQ_SYNTHESIS_JOB,
                BackgroundJob.status == JobStatus.QUEUED,
            )
        )
    )
    now = datetime.now(UTC)
    for job in jobs:
        job.status = JobStatus.CANCELLED
        job.completed_at = now
    runs = list(
        db.scalars(
            select(ResearchQuestionAnalysisRun).where(
                ResearchQuestionAnalysisRun.status.in_(["pending", "processing"])
            )
        )
    )
    for run in runs:
        run.status = "cancelled"
        run.completed_at = now
    db.flush()
    return len(jobs)


def generate_rq_synthesis_job(db: Session, job: BackgroundJob) -> dict[str, Any]:
    run = db.get(ResearchQuestionAnalysisRun, str(job.payload["rq_run_id"]))
    if run is None:
        return {"status": "cancelled", "reason": "run_missing"}
    if run.status == "completed":
        return {"runId": run.id, "idempotent": True}
    research_question = db.get(ResearchQuestion, run.research_question_id)
    if research_question is None:
        run.status = "failed"
        run.error = "Research question no longer exists"
        run.completed_at = datetime.now(UTC)
        db.flush()
        return {"runId": run.id, "status": "failed"}
    current_fingerprint = compute_rq_fingerprint(db, run.project_id, research_question)
    if current_fingerprint != run.input_fingerprint:
        run.status = "stale"
        run.completed_at = datetime.now(UTC)
        db.flush()
        return {"runId": run.id, "status": "stale"}
    run.model_configuration = with_attempt_sampling(
        run.model_configuration, job.attempts
    )
    run.status = "processing"
    run.started_at = datetime.now(UTC)
    db.commit()
    try:
        result_payload, _metrics = run_rq_synthesis(
            db, run.project_id, research_question.text, attempt=job.attempts
        )
    except OllamaTransientError as exc:
        raise TransientJobError(str(exc)) from exc
    except (OllamaResponseError, DomainError) as exc:
        run = db.get(ResearchQuestionAnalysisRun, run.id)
        assert run is not None
        run.status = "failed"
        run.error = str(exc)[:2000]
        run.completed_at = datetime.now(UTC)
        record_audit(
            db,
            action="rq_analysis.failed",
            entity_type="research_question_analysis_run",
            entity_id=run.id,
            project_id=run.project_id,
            actor_id=None,
            summary="Research-question synthesis failed",
            metadata={"error": run.error},
        )
        db.flush()
        return {"runId": run.id, "status": "failed", "error": run.error}
    if rq_run_was_cancelled(db, run):
        return {"runId": run.id, "status": "cancelled"}
    run.result = {
        "statements": result_payload["statements"],
        "limitations": result_payload["limitations"],
    }
    run.validated_source_refs = result_payload["sourceRefs"]
    run.status = "completed"
    run.completed_at = datetime.now(UTC)
    record_audit(
        db,
        action="rq_analysis.completed",
        entity_type="research_question_analysis_run",
        entity_id=run.id,
        project_id=run.project_id,
        actor_id=None,
        summary="Generated research-question synthesis",
        metadata={
            "researchQuestionId": run.research_question_id,
            "model": run.model,
            "promptVersion": run.prompt_template_version,
        },
    )
    db.flush()
    return {"runId": run.id, "status": "completed"}
