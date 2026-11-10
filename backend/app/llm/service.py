from __future__ import annotations

import hashlib
from collections.abc import Mapping

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.core.time import utcnow
from app.extraction.models import ExtractionResponse, ExtractionWorkItem
from app.fulltext.documents import active_document
from app.fulltext.models import PublicationDocument
from app.jobs.models import BackgroundJob, JobStatus
from app.jobs.service import enqueue_job
from app.llm.installation_settings import effective_llm_settings
from app.llm.models import (
    DocumentTextExtraction,
    ExtractionSuggestionReview,
    LlmExtractionRun,
    LlmFieldSuggestion,
    LlmTaskType,
    ProcessingStatus,
    SuggestionDisposition,
)
from app.llm.prompt import PROMPT_TEMPLATE_VERSION
from app.llm.schema_service import current_schema, mapping_state, project_settings
from app.llm.value_compare import canonical_json as _canonical_json
from app.llm.value_compare import values_equal
from app.projects.models import ScreeningStage
from app.screening.cohorts import has_final_outcome
from app.screening.models import ScreeningOutcome

TEXT_JOB = "extract_document_text"
LLM_JOB_TITLE_ABSTRACT_SCREENING = "llm_title_abstract_screening"
LLM_JOB_FULL_TEXT_SCREENING = "llm_full_text_screening"
LLM_JOB_DATA_EXTRACTION = "llm_data_extraction"
LLM_JOB_EXTRACTION_VALIDATION = "llm_extraction_validation"

LLM_JOB_TYPE_BY_TASK: dict[LlmTaskType, str] = {
    LlmTaskType.TITLE_ABSTRACT_SCREENING: LLM_JOB_TITLE_ABSTRACT_SCREENING,
    LlmTaskType.FULL_TEXT_SCREENING: LLM_JOB_FULL_TEXT_SCREENING,
    LlmTaskType.DATA_EXTRACTION: LLM_JOB_DATA_EXTRACTION,
    LlmTaskType.EXTRACTION_VALIDATION: LLM_JOB_EXTRACTION_VALIDATION,
}
# The canonical "which job types run on the --llm worker pool" set lives in
# app.jobs.registry.LLM_JOB_TYPES (derived from JOB_DEFINITIONS, which also
# covers STAGE_ANALYSIS_JOB and RQ_SYNTHESIS_JOB -- neither is keyed to
# LlmTaskType, so they can't be expressed via LLM_JOB_TYPE_BY_TASK above).
# Not re-exported here to avoid a circular import: jobs.registry needs
# TEXT_JOB/LLM_JOB_TYPE_BY_TASK from this module to build its per-task-type
# definitions.


def title_abstract_included(db: Session, publication_id: str) -> bool:
    return has_final_outcome(
        db, publication_id, ScreeningStage.TITLE_ABSTRACT, ScreeningOutcome.INCLUDE
    )


def full_text_excluded(db: Session, publication_id: str) -> bool:
    return has_final_outcome(
        db, publication_id, ScreeningStage.FULL_TEXT, ScreeningOutcome.EXCLUDE
    )


def project_llm_is_enabled(db: Session, project_id: str) -> bool:
    config = effective_llm_settings(db)
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


def queue_preparation_if_eligible(
    db: Session,
    publication_id: str,
    *,
    created_by_id: str | None = None,
    priority: int = 0,
    bulk_id: str | None = None,
) -> BackgroundJob | LlmExtractionRun | None:
    from app.llm.task_service import queue_document_processing

    return queue_document_processing(
        db,
        publication_id,
        created_by_id=created_by_id,
        priority=priority,
        bulk_id=bulk_id,
    )


def queue_llm_run_after_text(
    db: Session,
    extraction: DocumentTextExtraction,
    *,
    created_by_id: str | None,
    priority: int = 0,
    force: bool = False,
    bulk_id: str | None = None,
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
    config = effective_llm_settings(db)
    if schema is None or not config.ollama_model:
        return None
    from app.llm.task_service import data_extraction_fingerprint

    input_fingerprint = data_extraction_fingerprint(db, document, extraction, schema.id)
    active = db.scalar(
        select(LlmExtractionRun).where(
            LlmExtractionRun.document_id == document.id,
            LlmExtractionRun.schema_version_id == schema.id,
            LlmExtractionRun.task_type == LlmTaskType.DATA_EXTRACTION,
            LlmExtractionRun.input_fingerprint == input_fingerprint,
            LlmExtractionRun.status.in_(
                [ProcessingStatus.PENDING, ProcessingStatus.PROCESSING]
            ),
        )
    )
    if active:
        if bulk_id and active.bulk_id is None:
            active.bulk_id = bulk_id
        if active.background_job_id:
            job = db.get(BackgroundJob, active.background_job_id)
            if job:
                job.priority = max(job.priority, priority)
                if bulk_id and not job.payload.get("bulk_id"):
                    job.payload = {**job.payload, "bulk_id": bulk_id}
        return active
    if not force:
        completed = db.scalar(
            select(LlmExtractionRun)
            .where(
                LlmExtractionRun.document_id == document.id,
                LlmExtractionRun.schema_version_id == schema.id,
                LlmExtractionRun.task_type == LlmTaskType.DATA_EXTRACTION,
                LlmExtractionRun.input_fingerprint == input_fingerprint,
                LlmExtractionRun.status == ProcessingStatus.COMPLETED,
            )
            .order_by(LlmExtractionRun.completed_at.desc())
        )
        if completed:
            return completed
    run = LlmExtractionRun(
        project_id=document.project_id,
        publication_id=document.publication_id,
        task_type=LlmTaskType.DATA_EXTRACTION,
        bulk_id=bulk_id,
        input_fingerprint=input_fingerprint,
        document_id=document.id,
        schema_version_id=schema.id,
        text_extraction_id=extraction.id,
        provider="ollama",
        model=config.ollama_model,
        model_configuration={
            "temperature": 0,
            "think": False,
            "contextLength": config.llm_context_length,
        },
        prompt_template_version=PROMPT_TEMPLATE_VERSION,
        status=ProcessingStatus.PENDING,
        queued_at=utcnow(),
    )
    db.add(run)
    db.flush()
    job = enqueue_job(
        db,
        LLM_JOB_DATA_EXTRACTION,
        {"run_id": run.id, **({"bulk_id": bulk_id} if bulk_id else {})},
        project_id=document.project_id,
        created_by_id=created_by_id,
        max_attempts=3,
        priority=priority,
    )
    run.background_job_id = job.id
    db.flush()
    return run


def _schedule_digest_after_cancel(db: Session, project_ids: list[str]) -> None:
    # Cancelled runs never reach the worker's completion hook, which is what
    # normally schedules the "LLM processing finished" digest check.
    from app.notifications.service import schedule_llm_digest_checks

    schedule_llm_digest_checks(db, project_ids)


def fail_abandoned_llm_run(db: Session, job: BackgroundJob, error: str) -> None:
    """Permanent-failure hook for LLM jobs.

    The worker's own failure path already fails the run; this covers a job
    reaped after its worker died, whose run would otherwise stay processing.
    """
    from app.notifications.service import schedule_llm_digest_after_run

    run = db.get(LlmExtractionRun, str(job.payload.get("run_id")))
    if run is None or run.status not in {
        ProcessingStatus.PENDING,
        ProcessingStatus.PROCESSING,
    }:
        return
    run.status = ProcessingStatus.FAILED
    run.error_type = "worker_abandoned"
    run.error_message = error[:2000]
    run.completed_at = utcnow()
    db.flush()
    schedule_llm_digest_after_run(db, run)


def cancel_queued_for_publication(db: Session, publication_id: str) -> int:
    runs = list(
        db.scalars(
            select(LlmExtractionRun).where(
                LlmExtractionRun.publication_id == publication_id,
                LlmExtractionRun.task_type != LlmTaskType.TITLE_ABSTRACT_SCREENING,
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
    cancelled_text_jobs = [
        job
        for job in queued_text_jobs
        if str(job.payload.get("document_id")) in document_ids
    ]
    for job in cancelled_text_jobs:
        job.status = JobStatus.CANCELLED
        job.completed_at = utcnow()
    db.flush()
    _schedule_digest_after_cancel(
        db,
        [run.project_id for run in runs if run.bulk_id]
        + [
            job.project_id
            for job in cancelled_text_jobs
            if job.project_id and job.payload.get("bulk_id")
        ],
    )
    return len(runs)


def cancel_task_type_jobs(db: Session, project_id: str, task_type: LlmTaskType) -> int:
    """Stop the flow of new suggestions for one capability being disabled.

    Queued runs (and their still-queued background jobs) are cancelled
    outright. A run already ``PROCESSING`` is owned by a worker thread mid
    Ollama call; it's marked ``CANCELLED`` here so ``was_cancelled`` makes
    the worker discard the result instead of persisting it, but its
    background job is left alone since a worker is actively using it.
    """
    runs = list(
        db.scalars(
            select(LlmExtractionRun).where(
                LlmExtractionRun.project_id == project_id,
                LlmExtractionRun.task_type == task_type,
                LlmExtractionRun.status.in_(
                    [ProcessingStatus.PENDING, ProcessingStatus.PROCESSING]
                ),
            )
        )
    )
    for run in runs:
        was_pending = run.status == ProcessingStatus.PENDING
        run.status = ProcessingStatus.CANCELLED
        run.completed_at = utcnow()
        if was_pending and run.background_job_id:
            job = db.get(BackgroundJob, run.background_job_id)
            if job and job.status == JobStatus.QUEUED:
                job.status = JobStatus.CANCELLED
                job.completed_at = utcnow()
    db.flush()
    _schedule_digest_after_cancel(db, [run.project_id for run in runs if run.bulk_id])
    return len(runs)


def cancel_all_llm_jobs(db: Session) -> int:
    """Stop every in-flight LLM suggestion when support is disabled installation-wide.

    Unscoped version of ``cancel_task_type_jobs``: every project and task
    type is affected, since the installation toggle overrides all of them.
    Queued runs (and their still-queued background jobs) are cancelled
    outright. A run already ``PROCESSING`` is owned by a worker thread mid
    Ollama call; it's marked ``CANCELLED`` here so ``was_cancelled`` makes
    the worker discard the result instead of persisting it.
    """
    runs = list(
        db.scalars(
            select(LlmExtractionRun).where(
                LlmExtractionRun.status.in_(
                    [ProcessingStatus.PENDING, ProcessingStatus.PROCESSING]
                )
            )
        )
    )
    for run in runs:
        was_pending = run.status == ProcessingStatus.PENDING
        run.status = ProcessingStatus.CANCELLED
        run.completed_at = utcnow()
        if was_pending and run.background_job_id:
            job = db.get(BackgroundJob, run.background_job_id)
            if job and job.status == JobStatus.QUEUED:
                job.status = JobStatus.CANCELLED
                job.completed_at = utcnow()
    db.flush()
    _schedule_digest_after_cancel(db, [run.project_id for run in runs if run.bulk_id])
    return len(runs)


def cancel_project_llm_runs(db: Session, project_id: str) -> int:
    """Cancel every in-flight LLM run for one project.

    The project-scoped counterpart of ``cancel_all_llm_jobs``, used when a
    project manager cancels all of the project's background jobs: an LLM
    background job that is only stopped at the ``BackgroundJob`` level would
    otherwise leave its ``LlmExtractionRun`` stuck ``PENDING``/``PROCESSING``
    in the UI. A ``PROCESSING`` run is owned by a worker thread mid Ollama
    call; marking it ``CANCELLED`` makes ``was_cancelled`` discard the
    result. The caller cancels the ``BackgroundJob`` rows themselves.
    """
    runs = list(
        db.scalars(
            select(LlmExtractionRun).where(
                LlmExtractionRun.project_id == project_id,
                LlmExtractionRun.status.in_(
                    [ProcessingStatus.PENDING, ProcessingStatus.PROCESSING]
                ),
            )
        )
    )
    now = utcnow()
    for run in runs:
        run.status = ProcessingStatus.CANCELLED
        run.completed_at = now
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
            LlmExtractionRun.task_type == LlmTaskType.DATA_EXTRACTION,
        )
        .order_by(LlmExtractionRun.created_at.desc())
    )


def record_suggestion_provenance(
    db: Session,
    item: ExtractionWorkItem,
    response: ExtractionResponse,
    *,
    suggestion_actions: Mapping[str, str] | None = None,
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
        action = (suggestion_actions or {}).get(field_key)
        if action == "manual":
            disposition = SuggestionDisposition.MANUAL
        elif action == "ignored":
            disposition = SuggestionDisposition.NOT_USED
        elif action == "accepted" and suggestion is not None:
            disposition = (
                SuggestionDisposition.ACCEPTED
                if values_equal(suggestion.value, final_value)
                else SuggestionDisposition.MODIFIED
            )
        elif action == "modified" and suggestion is not None:
            disposition = SuggestionDisposition.MODIFIED
        elif suggestion is None:
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
    if suggestion_actions:
        from collections import Counter

        from app.audit.service import record_audit

        record_audit(
            db,
            action="llm.extraction_suggestions_reviewed",
            entity_type="extraction_response",
            entity_id=response.id,
            project_id=item.project_id,
            actor_id=response.reviewer_id,
            summary="Reviewed LLM extraction suggestions",
            metadata={"dispositions": dict(Counter(suggestion_actions.values()))},
        )
    db.flush()
