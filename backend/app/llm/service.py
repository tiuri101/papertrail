from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.conflicts.models import FinalDecision
from app.core.config import get_settings
from app.extraction.models import ExtractionResponse, ExtractionWorkItem
from app.fulltext.documents import active_document
from app.fulltext.models import PublicationDocument
from app.jobs.models import BackgroundJob, JobStatus
from app.jobs.service import enqueue_job
from app.llm.models import (
    DocumentTextExtraction,
    ExtractionSuggestionReview,
    LlmExtractionRun,
    LlmFieldSuggestion,
    ProcessingStatus,
    SuggestionDisposition,
)
from app.llm.prompt import PROMPT_TEMPLATE_VERSION
from app.llm.schema_service import current_schema, mapping_state, project_settings
from app.projects.models import ScreeningStage
from app.screening.models import ScreeningOutcome

TEXT_JOB = "extract_document_text"
LLM_JOB = "llm_extract_publication"


def utcnow() -> datetime:
    return datetime.now(UTC)


def title_abstract_included(db: Session, publication_id: str) -> bool:
    return (
        db.scalar(
            select(FinalDecision.id).where(
                FinalDecision.publication_id == publication_id,
                FinalDecision.stage == ScreeningStage.TITLE_ABSTRACT,
                FinalDecision.outcome == ScreeningOutcome.INCLUDE,
                FinalDecision.is_valid.is_(True),
            )
        )
        is not None
    )


def full_text_excluded(db: Session, publication_id: str) -> bool:
    return (
        db.scalar(
            select(FinalDecision.id).where(
                FinalDecision.publication_id == publication_id,
                FinalDecision.stage == ScreeningStage.FULL_TEXT,
                FinalDecision.outcome == ScreeningOutcome.EXCLUDE,
                FinalDecision.is_valid.is_(True),
            )
        )
        is not None
    )


def project_llm_is_enabled(db: Session, project_id: str) -> bool:
    config = get_settings()
    settings = project_settings(db, project_id)
    schema = current_schema(db, project_id)
    return bool(
        config.llm_enabled
        and settings
        and settings.enabled
        and schema
        and all(
            mapping_state(db, project_id, field) in {"active", "helper"}
            for field in schema.fields
            if field.enabled
        )
    )


def _pending_job(
    db: Session, job_type: str, key: str, value: str
) -> BackgroundJob | None:
    jobs = list(
        db.scalars(
            select(BackgroundJob).where(
                BackgroundJob.job_type == job_type,
                BackgroundJob.status.in_([JobStatus.QUEUED, JobStatus.RUNNING]),
            )
        )
    )
    return next((job for job in jobs if str(job.payload.get(key)) == value), None)


def queue_preparation_if_eligible(
    db: Session,
    publication_id: str,
    *,
    created_by_id: str | None = None,
    priority: int = 0,
) -> BackgroundJob | LlmExtractionRun | None:
    document = active_document(db, publication_id)
    if document is None or not title_abstract_included(db, publication_id):
        return None
    if full_text_excluded(db, publication_id) or not project_llm_is_enabled(
        db, document.project_id
    ):
        return None
    extraction = db.scalar(
        select(DocumentTextExtraction).where(
            DocumentTextExtraction.document_id == document.id
        )
    )
    if extraction and extraction.status == ProcessingStatus.COMPLETED:
        return queue_llm_run_after_text(
            db, extraction, created_by_id=created_by_id, priority=priority
        )
    if extraction is None:
        from app.llm.text_extraction import ensure_text_extraction

        extraction = ensure_text_extraction(db, document.id)
    if extraction.status == ProcessingStatus.UNSUPPORTED:
        return None
    pending = _pending_job(db, TEXT_JOB, "document_id", document.id)
    if pending:
        pending.priority = max(pending.priority, priority)
        return pending
    return enqueue_job(
        db,
        TEXT_JOB,
        {"document_id": document.id, "text_extraction_id": extraction.id},
        project_id=document.project_id,
        created_by_id=created_by_id,
        max_attempts=2,
        priority=priority,
    )


def queue_llm_run_after_text(
    db: Session,
    extraction: DocumentTextExtraction,
    *,
    created_by_id: str | None,
    priority: int = 0,
    force: bool = False,
) -> LlmExtractionRun | None:
    document = db.get(PublicationDocument, extraction.document_id)
    if (
        document is None
        or not document.is_active
        or extraction.status != ProcessingStatus.COMPLETED
        or not title_abstract_included(db, document.publication_id)
        or full_text_excluded(db, document.publication_id)
        or not project_llm_is_enabled(db, document.project_id)
    ):
        return None
    schema = current_schema(db, document.project_id)
    config = get_settings()
    if schema is None or not config.ollama_model:
        return None
    active = db.scalar(
        select(LlmExtractionRun).where(
            LlmExtractionRun.document_id == document.id,
            LlmExtractionRun.schema_version_id == schema.id,
            LlmExtractionRun.status.in_(
                [ProcessingStatus.PENDING, ProcessingStatus.PROCESSING]
            ),
        )
    )
    if active:
        if active.background_job_id:
            job = db.get(BackgroundJob, active.background_job_id)
            if job:
                job.priority = max(job.priority, priority)
        return active
    if not force:
        completed = db.scalar(
            select(LlmExtractionRun)
            .where(
                LlmExtractionRun.document_id == document.id,
                LlmExtractionRun.schema_version_id == schema.id,
                LlmExtractionRun.status == ProcessingStatus.COMPLETED,
            )
            .order_by(LlmExtractionRun.completed_at.desc())
        )
        if completed:
            return completed
    run = LlmExtractionRun(
        project_id=document.project_id,
        publication_id=document.publication_id,
        document_id=document.id,
        schema_version_id=schema.id,
        text_extraction_id=extraction.id,
        provider="ollama",
        model=config.ollama_model,
        prompt_template_version=PROMPT_TEMPLATE_VERSION,
        status=ProcessingStatus.PENDING,
        queued_at=utcnow(),
    )
    db.add(run)
    db.flush()
    job = enqueue_job(
        db,
        LLM_JOB,
        {"run_id": run.id},
        project_id=document.project_id,
        created_by_id=created_by_id,
        max_attempts=3,
        priority=priority,
    )
    run.background_job_id = job.id
    db.flush()
    return run


def cancel_queued_for_publication(db: Session, publication_id: str) -> int:
    runs = list(
        db.scalars(
            select(LlmExtractionRun).where(
                LlmExtractionRun.publication_id == publication_id,
                LlmExtractionRun.status == ProcessingStatus.PENDING,
            )
        )
    )
    for run in runs:
        run.status = ProcessingStatus.CANCELLED
        run.completed_at = utcnow()
        if run.background_job_id:
            job = db.get(BackgroundJob, run.background_job_id)
            if job and job.status == JobStatus.QUEUED:
                job.status = JobStatus.CANCELLED
                job.completed_at = utcnow()
    document_ids = set(
        db.scalars(
            select(PublicationDocument.id).where(
                PublicationDocument.publication_id == publication_id
            )
        )
    )
    queued_text_jobs = list(
        db.scalars(
            select(BackgroundJob).where(
                BackgroundJob.job_type == TEXT_JOB,
                BackgroundJob.status == JobStatus.QUEUED,
            )
        )
    )
    for job in queued_text_jobs:
        if str(job.payload.get("document_id")) in document_ids:
            job.status = JobStatus.CANCELLED
            job.completed_at = utcnow()
    db.flush()
    return len(runs)


def latest_current_run(
    db: Session, project_id: str, publication_id: str
) -> LlmExtractionRun | None:
    schema = current_schema(db, project_id)
    document = active_document(db, publication_id)
    if schema is None or document is None:
        return None
    return db.scalar(
        select(LlmExtractionRun)
        .options(selectinload(LlmExtractionRun.suggestions))
        .where(
            LlmExtractionRun.project_id == project_id,
            LlmExtractionRun.publication_id == publication_id,
            LlmExtractionRun.document_id == document.id,
            LlmExtractionRun.schema_version_id == schema.id,
        )
        .order_by(LlmExtractionRun.created_at.desc())
    )


def _canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def values_equal(left: Any, right: Any) -> bool:
    if isinstance(left, list) and isinstance(right, list):
        return sorted(map(_canonical_json, left)) == sorted(map(_canonical_json, right))
    if isinstance(left, (int, float)) and isinstance(right, (int, float)):
        return float(left) == float(right)
    return bool(left == right)


def record_suggestion_provenance(
    db: Session,
    item: ExtractionWorkItem,
    response: ExtractionResponse,
) -> None:
    run = latest_current_run(db, item.project_id, item.publication_id)
    run_suggestions = (
        list(
            db.scalars(
                select(LlmFieldSuggestion).where(LlmFieldSuggestion.run_id == run.id)
            )
        )
        if run and run.status == ProcessingStatus.COMPLETED
        else []
    )
    suggestions = {
        suggestion.mapped_extraction_field_key: suggestion
        for suggestion in run_suggestions
        if suggestion.mapped_extraction_field_key
    }
    for field_key, final_value in response.answers.items():
        suggestion = suggestions.get(field_key)
        if suggestion is None:
            disposition = SuggestionDisposition.NOT_USED
        elif values_equal(suggestion.value, final_value):
            disposition = SuggestionDisposition.ACCEPTED
        elif final_value in (None, "", []):
            disposition = SuggestionDisposition.NOT_USED
        elif suggestion.value in (None, "", []):
            disposition = SuggestionDisposition.REPLACED
        else:
            disposition = SuggestionDisposition.MODIFIED
        serialized = _canonical_json(final_value)
        db.add(
            ExtractionSuggestionReview(
                extraction_response_id=response.id,
                project_id=item.project_id,
                publication_id=item.publication_id,
                reviewer_id=response.reviewer_id,
                response_version=response.version,
                extraction_field_key=field_key,
                suggestion_id=suggestion.id if suggestion else None,
                reviewer_final_value=final_value,
                reviewer_final_value_hash=hashlib.sha256(
                    serialized.encode()
                ).hexdigest(),
                disposition=disposition,
            )
        )
    db.flush()
