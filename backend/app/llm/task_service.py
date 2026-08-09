from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.conflicts.models import FinalDecision
from app.core.config import get_settings
from app.extraction.models import (
    ExtractionResponse,
    ExtractionStatus,
    ExtractionWorkItem,
)
from app.fulltext.documents import active_document
from app.fulltext.models import PublicationDocument
from app.jobs.models import BackgroundJob, JobStatus
from app.jobs.service import enqueue_job
from app.llm.models import (
    DocumentTextExtraction,
    LlmExtractionRun,
    LlmTaskType,
    ProcessingStatus,
)
from app.llm.prompt import PROMPT_TEMPLATE_VERSION
from app.llm.schema_service import current_schema, project_settings
from app.llm.task_prompt import (
    EXTRACTION_VALIDATION_PROMPT_VERSION,
    FULL_TEXT_PROMPT_VERSION,
    TITLE_ABSTRACT_PROMPT_VERSION,
)
from app.projects.models import Criterion, ScreeningStage
from app.publications.models import Publication
from app.screening.models import ScreeningOutcome


@dataclass(frozen=True)
class ValidationProgress:
    total: int
    completed: int
    pending: int
    failed: int
    unavailable: int
    outstanding: int

    @property
    def settled(self) -> bool:
        return self.total == (self.completed + self.failed + self.unavailable)


def _canonical(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def fingerprint(value: Any) -> str:
    return hashlib.sha256(_canonical(value).encode("utf-8")).hexdigest()


def active_criteria(db: Session, project_id: str) -> list[Criterion]:
    return list(
        db.scalars(
            select(Criterion)
            .where(Criterion.project_id == project_id, Criterion.is_active.is_(True))
            .order_by(Criterion.position, Criterion.id)
        )
    )


def _criteria_input(criteria: list[Criterion]) -> list[dict[str, Any]]:
    return [
        {"id": item.id, "kind": item.kind.value, "text": item.text} for item in criteria
    ]


def _model() -> str | None:
    config = get_settings()
    return config.ollama_model if config.llm_enabled else None


def feature_enabled(db: Session, project_id: str, task_type: LlmTaskType) -> bool:
    if _model() is None:
        return False
    settings = project_settings(db, project_id)
    if settings is None:
        return False
    return {
        LlmTaskType.TITLE_ABSTRACT_SCREENING: settings.title_abstract_screening_enabled,
        LlmTaskType.FULL_TEXT_SCREENING: settings.full_text_screening_enabled,
        LlmTaskType.DATA_EXTRACTION: settings.enabled,
        LlmTaskType.EXTRACTION_VALIDATION: settings.extraction_validation_enabled,
    }[task_type]


def _title_input(db: Session, publication: Publication) -> dict[str, Any]:
    return {
        "prompt": TITLE_ABSTRACT_PROMPT_VERSION,
        "model": _model(),
        "publication": {
            "title": publication.title,
            "abstract": publication.abstract,
            "authors": publication.authors,
            "year": publication.publication_year,
            "venue": publication.venue,
            "type": publication.publication_type,
        },
        "criteria": _criteria_input(active_criteria(db, publication.project_id)),
    }


def title_abstract_fingerprint(db: Session, publication: Publication) -> str:
    return fingerprint(_title_input(db, publication))


def full_text_fingerprint(
    db: Session,
    publication: Publication,
    document: PublicationDocument,
    extraction: DocumentTextExtraction,
) -> str:
    return fingerprint(
        {
            "prompt": FULL_TEXT_PROMPT_VERSION,
            "model": _model(),
            "publication": publication.id,
            "document": document.id,
            "sha256": document.sha256,
            "textExtraction": extraction.id,
            "extractor": [extraction.extractor, extraction.extractor_version],
            "criteria": _criteria_input(active_criteria(db, publication.project_id)),
        }
    )


def data_extraction_fingerprint(
    document: PublicationDocument, extraction: DocumentTextExtraction, schema_id: str
) -> str:
    return fingerprint(
        {
            "prompt": PROMPT_TEMPLATE_VERSION,
            "model": _model(),
            "document": document.id,
            "sha256": document.sha256,
            "textExtraction": extraction.id,
            "schema": schema_id,
        }
    )


def validation_fingerprint(
    document: PublicationDocument,
    extraction: DocumentTextExtraction,
    response: ExtractionResponse,
) -> str:
    return fingerprint(
        {
            "prompt": EXTRACTION_VALIDATION_PROMPT_VERSION,
            "model": _model(),
            "document": document.id,
            "sha256": document.sha256,
            "textExtraction": extraction.id,
            "response": response.id,
            "formVersion": response.form_version_id,
            "answers": response.answers,
        }
    )


def _existing_run(
    db: Session,
    publication_id: str,
    task_type: LlmTaskType,
    input_fingerprint: str,
    *,
    force: bool,
) -> LlmExtractionRun | None:
    statuses = [ProcessingStatus.PENDING, ProcessingStatus.PROCESSING]
    if not force:
        statuses.append(ProcessingStatus.COMPLETED)
    return db.scalar(
        select(LlmExtractionRun)
        .where(
            LlmExtractionRun.publication_id == publication_id,
            LlmExtractionRun.task_type == task_type,
            LlmExtractionRun.input_fingerprint == input_fingerprint,
            LlmExtractionRun.status.in_(statuses),
        )
        .order_by(LlmExtractionRun.created_at.desc())
    )


def _create_run(
    db: Session,
    *,
    publication: Publication,
    task_type: LlmTaskType,
    input_fingerprint: str,
    prompt_version: str,
    created_by_id: str | None,
    priority: int,
    force: bool,
    bulk_id: str | None = None,
    document: PublicationDocument | None = None,
    extraction: DocumentTextExtraction | None = None,
    extraction_response: ExtractionResponse | None = None,
) -> LlmExtractionRun:
    existing = _existing_run(
        db, publication.id, task_type, input_fingerprint, force=force
    )
    if existing is not None:
        if bulk_id and existing.bulk_id is None:
            existing.bulk_id = bulk_id
        # A low-priority precomputed run may already exist by the time a reviewer
        # opens the publication. Promote its still-queued job so the suggestion is
        # ready when the independent human decision is submitted.
        if existing.background_job_id is not None:
            job = db.get(BackgroundJob, existing.background_job_id)
            if (
                job is not None
                and job.status == JobStatus.QUEUED
                and job.priority < priority
            ):
                job.priority = priority
            if job is not None and bulk_id and not job.payload.get("bulk_id"):
                job.payload = {**job.payload, "bulk_id": bulk_id}
        return existing
    model = _model()
    if model is None:
        raise RuntimeError("LLM support is not configured")
    run = LlmExtractionRun(
        project_id=publication.project_id,
        publication_id=publication.id,
        task_type=task_type,
        bulk_id=bulk_id,
        input_fingerprint=input_fingerprint,
        document_id=document.id if document else None,
        text_extraction_id=extraction.id if extraction else None,
        extraction_response_id=extraction_response.id if extraction_response else None,
        provider="ollama",
        model=model,
        model_configuration={
            "temperature": 0,
            "think": False,
            "contextLength": get_settings().llm_context_length,
        },
        prompt_template_version=prompt_version,
        status=ProcessingStatus.PENDING,
        queued_at=datetime.now(UTC),
    )
    db.add(run)
    db.flush()
    from app.llm.service import LLM_JOB

    job = enqueue_job(
        db,
        LLM_JOB,
        {"run_id": run.id, **({"bulk_id": bulk_id} if bulk_id else {})},
        project_id=publication.project_id,
        created_by_id=created_by_id,
        max_attempts=3,
        priority=priority,
    )
    run.background_job_id = job.id
    db.flush()
    return run


def queue_title_abstract_suggestion(
    db: Session,
    publication_id: str,
    *,
    created_by_id: str | None = None,
    priority: int = 0,
    force: bool = False,
    bulk_id: str | None = None,
) -> LlmExtractionRun | None:
    publication = db.get(Publication, publication_id)
    if (
        publication is None
        or not publication.is_active
        or not feature_enabled(
            db, publication.project_id, LlmTaskType.TITLE_ABSTRACT_SCREENING
        )
    ):
        return None
    return _create_run(
        db,
        publication=publication,
        task_type=LlmTaskType.TITLE_ABSTRACT_SCREENING,
        input_fingerprint=title_abstract_fingerprint(db, publication),
        prompt_version=TITLE_ABSTRACT_PROMPT_VERSION,
        created_by_id=created_by_id,
        priority=priority,
        force=force,
        bulk_id=bulk_id,
    )


def _title_included(db: Session, publication_id: str) -> bool:
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


def _full_text_excluded(db: Session, publication_id: str) -> bool:
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


def queue_full_text_assistance(
    db: Session,
    publication_id: str,
    *,
    created_by_id: str | None = None,
    priority: int = 0,
    force: bool = False,
    extraction: DocumentTextExtraction | None = None,
    bulk_id: str | None = None,
) -> LlmExtractionRun | BackgroundJob | None:
    publication = db.get(Publication, publication_id)
    if (
        publication is None
        or not _title_included(db, publication_id)
        or _full_text_excluded(db, publication_id)
        or not feature_enabled(
            db, publication.project_id, LlmTaskType.FULL_TEXT_SCREENING
        )
    ):
        return None
    document = active_document(db, publication_id)
    if document is None:
        return None
    extraction = extraction or db.scalar(
        select(DocumentTextExtraction).where(
            DocumentTextExtraction.document_id == document.id
        )
    )
    if extraction is None or extraction.status != ProcessingStatus.COMPLETED:
        return queue_document_processing(
            db,
            publication_id,
            created_by_id=created_by_id,
            priority=priority,
            bulk_id=bulk_id,
        )
    return _create_run(
        db,
        publication=publication,
        task_type=LlmTaskType.FULL_TEXT_SCREENING,
        input_fingerprint=full_text_fingerprint(db, publication, document, extraction),
        prompt_version=FULL_TEXT_PROMPT_VERSION,
        created_by_id=created_by_id,
        priority=priority,
        force=force,
        bulk_id=bulk_id,
        document=document,
        extraction=extraction,
    )


def _current_response(db: Session, publication_id: str) -> ExtractionResponse | None:
    return db.scalar(
        select(ExtractionResponse)
        .join(ExtractionWorkItem)
        .where(
            ExtractionWorkItem.publication_id == publication_id,
            ExtractionResponse.is_current.is_(True),
        )
        .order_by(ExtractionResponse.created_at.desc())
    )


def project_extractions_completed(db: Session, project_id: str) -> bool:
    items = list(
        db.scalars(
            select(ExtractionWorkItem).where(
                ExtractionWorkItem.project_id == project_id
            )
        )
    )
    return bool(items) and all(
        item.status == ExtractionStatus.COMPLETED for item in items
    )


def current_validation_run(
    db: Session, item: ExtractionWorkItem
) -> LlmExtractionRun | None:
    response = db.scalar(
        select(ExtractionResponse)
        .where(
            ExtractionResponse.work_item_id == item.id,
            ExtractionResponse.is_current.is_(True),
        )
        .order_by(ExtractionResponse.created_at.desc())
    )
    document = active_document(db, item.publication_id)
    if response is None or document is None:
        return None
    return db.scalar(
        select(LlmExtractionRun)
        .options(selectinload(LlmExtractionRun.validation_results))
        .where(
            LlmExtractionRun.project_id == item.project_id,
            LlmExtractionRun.publication_id == item.publication_id,
            LlmExtractionRun.document_id == document.id,
            LlmExtractionRun.extraction_response_id == response.id,
            LlmExtractionRun.task_type == LlmTaskType.EXTRACTION_VALIDATION,
        )
        .order_by(LlmExtractionRun.created_at.desc())
    )


def project_validation_progress(db: Session, project_id: str) -> ValidationProgress:
    items = list(
        db.scalars(
            select(ExtractionWorkItem)
            .where(ExtractionWorkItem.project_id == project_id)
            .order_by(ExtractionWorkItem.random_rank)
        )
    )
    completed = pending = failed = unavailable = outstanding = 0
    for item in items:
        if item.status != ExtractionStatus.COMPLETED:
            outstanding += 1
            continue
        document = active_document(db, item.publication_id)
        if document is None:
            unavailable += 1
            continue
        text_extraction = db.scalar(
            select(DocumentTextExtraction).where(
                DocumentTextExtraction.document_id == document.id
            )
        )
        if text_extraction is not None and text_extraction.status in {
            ProcessingStatus.FAILED,
            ProcessingStatus.UNSUPPORTED,
        }:
            unavailable += 1
            continue
        run = current_validation_run(db, item)
        if run is None or run.status == ProcessingStatus.STALE:
            outstanding += 1
        elif run.status == ProcessingStatus.COMPLETED:
            completed += 1
        elif run.status in {ProcessingStatus.PENDING, ProcessingStatus.PROCESSING}:
            pending += 1
        else:
            failed += 1
    return ValidationProgress(
        total=len(items),
        completed=completed,
        pending=pending,
        failed=failed,
        unavailable=unavailable,
        outstanding=outstanding,
    )


def queue_project_extraction_validations(
    db: Session,
    project_id: str,
    *,
    created_by_id: str | None = None,
    priority: int = 10,
) -> list[LlmExtractionRun | BackgroundJob]:
    if not project_extractions_completed(db, project_id) or not feature_enabled(
        db, project_id, LlmTaskType.EXTRACTION_VALIDATION
    ):
        return []
    queued: list[LlmExtractionRun | BackgroundJob] = []
    bulk_id = str(uuid4())
    publication_ids = list(
        db.scalars(
            select(ExtractionWorkItem.publication_id).where(
                ExtractionWorkItem.project_id == project_id,
                ExtractionWorkItem.status == ExtractionStatus.COMPLETED,
            )
        )
    )
    for publication_id in publication_ids:
        result = queue_extraction_validation(
            db,
            publication_id,
            created_by_id=created_by_id,
            priority=priority,
            bulk_id=bulk_id,
        )
        if result is not None:
            queued.append(result)
    return queued


def queue_extraction_validation(
    db: Session,
    publication_id: str,
    *,
    response: ExtractionResponse | None = None,
    created_by_id: str | None = None,
    priority: int = 10,
    force: bool = False,
    extraction: DocumentTextExtraction | None = None,
    allow_disabled_manual: bool = False,
    bulk_id: str | None = None,
) -> LlmExtractionRun | BackgroundJob | None:
    publication = db.get(Publication, publication_id)
    if publication is None:
        return None
    if not allow_disabled_manual and not feature_enabled(
        db, publication.project_id, LlmTaskType.EXTRACTION_VALIDATION
    ):
        return None
    if allow_disabled_manual and _model() is None:
        return None
    response = response or _current_response(db, publication_id)
    document = active_document(db, publication_id)
    if response is None or document is None:
        return None
    extraction = extraction or db.scalar(
        select(DocumentTextExtraction).where(
            DocumentTextExtraction.document_id == document.id
        )
    )
    if extraction is None or extraction.status != ProcessingStatus.COMPLETED:
        return queue_document_processing(
            db,
            publication_id,
            created_by_id=created_by_id,
            priority=priority,
            bulk_id=bulk_id,
        )
    return _create_run(
        db,
        publication=publication,
        task_type=LlmTaskType.EXTRACTION_VALIDATION,
        input_fingerprint=validation_fingerprint(document, extraction, response),
        prompt_version=EXTRACTION_VALIDATION_PROMPT_VERSION,
        created_by_id=created_by_id,
        priority=priority,
        force=force,
        bulk_id=bulk_id,
        document=document,
        extraction=extraction,
        extraction_response=response,
    )


def queue_document_processing(
    db: Session,
    publication_id: str,
    *,
    created_by_id: str | None = None,
    priority: int = 0,
    bulk_id: str | None = None,
) -> LlmExtractionRun | BackgroundJob | None:
    publication = db.get(Publication, publication_id)
    if publication is None or not _title_included(db, publication_id):
        return None
    settings = project_settings(db, publication.project_id)
    if (
        _model() is None
        or settings is None
        or not (
            settings.enabled
            or settings.full_text_screening_enabled
            or settings.extraction_validation_enabled
        )
    ):
        return None
    document = active_document(db, publication_id)
    if document is None:
        return None
    extraction = db.scalar(
        select(DocumentTextExtraction).where(
            DocumentTextExtraction.document_id == document.id
        )
    )
    if extraction and extraction.status == ProcessingStatus.COMPLETED:
        return queue_tasks_after_text(
            db,
            extraction,
            created_by_id=created_by_id,
            priority=priority,
            bulk_id=bulk_id,
        )
    if extraction is None:
        from app.llm.text_extraction import ensure_text_extraction

        extraction = ensure_text_extraction(db, document.id)
    if extraction.status == ProcessingStatus.UNSUPPORTED:
        return None
    from app.llm.service import TEXT_JOB

    jobs = list(
        db.scalars(
            select(BackgroundJob).where(
                BackgroundJob.job_type == TEXT_JOB,
                BackgroundJob.status.in_([JobStatus.QUEUED, JobStatus.RUNNING]),
            )
        )
    )
    pending = next(
        (job for job in jobs if str(job.payload.get("document_id")) == document.id),
        None,
    )
    if pending:
        pending.priority = max(pending.priority, priority)
        if bulk_id and not pending.payload.get("bulk_id"):
            pending.payload = {**pending.payload, "bulk_id": bulk_id}
        return pending
    return enqueue_job(
        db,
        TEXT_JOB,
        {
            "document_id": document.id,
            "text_extraction_id": extraction.id,
            **({"bulk_id": bulk_id} if bulk_id else {}),
        },
        project_id=publication.project_id,
        created_by_id=created_by_id,
        max_attempts=2,
        priority=priority,
    )


def queue_tasks_after_text(
    db: Session,
    extraction: DocumentTextExtraction,
    *,
    created_by_id: str | None,
    priority: int = 0,
    bulk_id: str | None = None,
) -> LlmExtractionRun | None:
    document = db.get(PublicationDocument, extraction.document_id)
    if document is None or not document.is_active:
        return None
    queued: LlmExtractionRun | None = None
    full = queue_full_text_assistance(
        db,
        document.publication_id,
        created_by_id=created_by_id,
        priority=priority,
        extraction=extraction,
        bulk_id=bulk_id,
    )
    if isinstance(full, LlmExtractionRun):
        queued = full
    from app.llm.service import queue_llm_run_after_text

    extraction_run = queue_llm_run_after_text(
        db,
        extraction,
        created_by_id=created_by_id,
        priority=priority,
        bulk_id=bulk_id,
    )
    if extraction_run is not None:
        queued = extraction_run
    response = _current_response(db, document.publication_id)
    if response is not None and project_extractions_completed(db, document.project_id):
        validation = queue_extraction_validation(
            db,
            document.publication_id,
            response=response,
            created_by_id=created_by_id,
            priority=max(priority, 10),
            extraction=extraction,
            bulk_id=bulk_id,
        )
        if isinstance(validation, LlmExtractionRun):
            queued = validation
    return queued


def latest_task_run(
    db: Session, publication_id: str, task_type: LlmTaskType
) -> LlmExtractionRun | None:
    return db.scalar(
        select(LlmExtractionRun)
        .options(
            selectinload(LlmExtractionRun.criterion_suggestions),
            selectinload(LlmExtractionRun.validation_results),
            selectinload(LlmExtractionRun.suggestions),
        )
        .where(
            LlmExtractionRun.publication_id == publication_id,
            LlmExtractionRun.task_type == task_type,
        )
        .order_by(LlmExtractionRun.created_at.desc())
    )


def current_task_fingerprint(db: Session, run: LlmExtractionRun) -> str | None:
    publication = db.get(Publication, run.publication_id)
    if publication is None:
        return None
    if run.task_type == LlmTaskType.TITLE_ABSTRACT_SCREENING:
        return title_abstract_fingerprint(db, publication)
    document = active_document(db, publication.id)
    if document is None:
        return None
    extraction = db.scalar(
        select(DocumentTextExtraction).where(
            DocumentTextExtraction.document_id == document.id,
            DocumentTextExtraction.status == ProcessingStatus.COMPLETED,
        )
    )
    if extraction is None:
        return None
    if run.task_type == LlmTaskType.FULL_TEXT_SCREENING:
        return full_text_fingerprint(db, publication, document, extraction)
    if run.task_type == LlmTaskType.DATA_EXTRACTION:
        schema = current_schema(db, publication.project_id)
        return (
            data_extraction_fingerprint(document, extraction, schema.id)
            if schema
            else None
        )
    response = _current_response(db, publication.id)
    return validation_fingerprint(document, extraction, response) if response else None


def run_is_stale(db: Session, run: LlmExtractionRun) -> bool:
    current = current_task_fingerprint(db, run)
    return current is None or current != run.input_fingerprint
