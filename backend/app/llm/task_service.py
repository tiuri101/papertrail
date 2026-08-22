from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.extraction.final import (
    get_current_final_extraction,
    get_current_final_extractions,
)
from app.extraction.models import (
    ExtractionResponse,
    ExtractionStatus,
    ExtractionWorkItem,
    FinalExtraction,
)
from app.fulltext.documents import active_document
from app.fulltext.models import PublicationDocument
from app.jobs.models import BackgroundJob, JobStatus
from app.jobs.service import enqueue_job
from app.llm.installation_settings import effective_llm_settings
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
from app.projects.models import Criterion, ResearchQuestion, ScreeningStage
from app.publications.models import Publication
from app.screening.cohorts import (
    decided_ids_for_stage,
    full_text_excluded_ids,
    full_text_included_ids,
    has_final_outcome,
    title_abstract_included_ids,
)
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


def active_research_questions(db: Session, project_id: str) -> list[ResearchQuestion]:
    return list(
        db.scalars(
            select(ResearchQuestion)
            .where(
                ResearchQuestion.project_id == project_id,
                ResearchQuestion.is_active.is_(True),
            )
            .order_by(ResearchQuestion.position, ResearchQuestion.id)
        )
    )


def _research_questions_input(
    questions: list[ResearchQuestion],
) -> list[dict[str, Any]]:
    return [{"id": item.id, "text": item.text} for item in questions]


def _model(db: Session) -> str | None:
    config = effective_llm_settings(db)
    return config.ollama_model if config.llm_enabled else None


def feature_enabled(db: Session, project_id: str, task_type: LlmTaskType) -> bool:
    if _model(db) is None:
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
        "model": _model(db),
        "publication": {
            "title": publication.title,
            "abstract": publication.abstract,
            "authors": publication.authors,
            "year": publication.publication_year,
            "venue": publication.venue,
            "type": publication.publication_type,
        },
        "criteria": _criteria_input(active_criteria(db, publication.project_id)),
        "researchQuestions": _research_questions_input(
            active_research_questions(db, publication.project_id)
        ),
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
            "model": _model(db),
            "publication": publication.id,
            "document": document.id,
            "sha256": document.sha256,
            "textExtraction": extraction.id,
            "extractor": [extraction.extractor, extraction.extractor_version],
            "criteria": _criteria_input(active_criteria(db, publication.project_id)),
            "researchQuestions": _research_questions_input(
                active_research_questions(db, publication.project_id)
            ),
        }
    )


def data_extraction_fingerprint(
    db: Session,
    document: PublicationDocument,
    extraction: DocumentTextExtraction,
    schema_id: str,
) -> str:
    return fingerprint(
        {
            "prompt": PROMPT_TEMPLATE_VERSION,
            "model": _model(db),
            "document": document.id,
            "sha256": document.sha256,
            "textExtraction": extraction.id,
            "schema": schema_id,
            "researchQuestions": _research_questions_input(
                active_research_questions(db, document.project_id)
            ),
        }
    )


def validation_fingerprint(
    db: Session,
    document: PublicationDocument,
    extraction: DocumentTextExtraction,
    final: FinalExtraction,
) -> str:
    return fingerprint(
        {
            "prompt": EXTRACTION_VALIDATION_PROMPT_VERSION,
            "model": _model(db),
            "document": document.id,
            "sha256": document.sha256,
            "textExtraction": extraction.id,
            "finalExtraction": final.id,
            "formVersion": final.form_version_id,
            "answers": final.answers,
            "researchQuestions": _research_questions_input(
                active_research_questions(db, document.project_id)
            ),
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
    final_extraction: FinalExtraction | None = None,
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
    model = _model(db)
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
        final_extraction_id=final_extraction.id if final_extraction else None,
        provider="ollama",
        model=model,
        model_configuration={
            "temperature": 0,
            "think": False,
            "contextLength": effective_llm_settings(db).llm_context_length,
        },
        prompt_template_version=prompt_version,
        status=ProcessingStatus.PENDING,
        queued_at=datetime.now(UTC),
    )
    db.add(run)
    db.flush()
    from app.llm.service import LLM_JOB_TYPE_BY_TASK

    job = enqueue_job(
        db,
        LLM_JOB_TYPE_BY_TASK[task_type],
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
    return has_final_outcome(
        db, publication_id, ScreeningStage.TITLE_ABSTRACT, ScreeningOutcome.INCLUDE
    )


def _full_text_excluded(db: Session, publication_id: str) -> bool:
    return has_final_outcome(
        db, publication_id, ScreeningStage.FULL_TEXT, ScreeningOutcome.EXCLUDE
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


def project_extractions_completed(db: Session, project_id: str) -> bool:
    """Whether every included publication has an authoritative
    FinalExtraction -- not merely that every individual reviewer slot is
    COMPLETED, which in dual-extraction mode can be true while a
    publication still sits in reconciliation with no final result yet."""
    from app.extraction.service import included_publication_ids

    publication_ids = included_publication_ids(db, project_id)
    if not publication_ids:
        return False
    finals = get_current_final_extractions(db, publication_ids)
    return set(finals) == set(publication_ids)


def current_validation_run(db: Session, publication_id: str) -> LlmExtractionRun | None:
    final = get_current_final_extraction(db, publication_id)
    document = active_document(db, publication_id)
    if final is None or document is None:
        return None
    return db.scalar(
        select(LlmExtractionRun)
        .options(selectinload(LlmExtractionRun.validation_results))
        .where(
            LlmExtractionRun.publication_id == publication_id,
            LlmExtractionRun.document_id == document.id,
            LlmExtractionRun.final_extraction_id == final.id,
            LlmExtractionRun.task_type == LlmTaskType.EXTRACTION_VALIDATION,
        )
        .order_by(LlmExtractionRun.created_at.desc())
    )


def project_validation_progress(db: Session, project_id: str) -> ValidationProgress:
    from app.extraction.service import included_publication_ids

    publication_ids = included_publication_ids(db, project_id)
    finals = get_current_final_extractions(db, publication_ids)
    completed = pending = failed = unavailable = outstanding = 0
    for publication_id in publication_ids:
        if publication_id not in finals:
            outstanding += 1
            continue
        document = active_document(db, publication_id)
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
        run = current_validation_run(db, publication_id)
        if run is None or run.status == ProcessingStatus.STALE:
            outstanding += 1
        elif run.status == ProcessingStatus.COMPLETED:
            completed += 1
        elif run.status in {ProcessingStatus.PENDING, ProcessingStatus.PROCESSING}:
            pending += 1
        else:
            failed += 1
    return ValidationProgress(
        total=len(publication_ids),
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
    force: bool = False,
    bulk_id: str | None = None,
) -> list[LlmExtractionRun | BackgroundJob]:
    if not project_extractions_completed(db, project_id) or not feature_enabled(
        db, project_id, LlmTaskType.EXTRACTION_VALIDATION
    ):
        return []
    from app.extraction.service import included_publication_ids

    queued: list[LlmExtractionRun | BackgroundJob] = []
    bulk_id = bulk_id or str(uuid4())
    publication_ids = get_current_final_extractions(
        db, included_publication_ids(db, project_id)
    ).keys()
    for publication_id in publication_ids:
        result = queue_extraction_validation(
            db,
            publication_id,
            created_by_id=created_by_id,
            priority=priority,
            force=force,
            bulk_id=bulk_id,
        )
        if result is not None:
            queued.append(result)
    return queued


def queue_extraction_validation(
    db: Session,
    publication_id: str,
    *,
    final_extraction: FinalExtraction | None = None,
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
    if allow_disabled_manual and _model(db) is None:
        return None
    final_extraction = final_extraction or get_current_final_extraction(
        db, publication_id
    )
    document = active_document(db, publication_id)
    if final_extraction is None or document is None:
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
        input_fingerprint=validation_fingerprint(
            db, document, extraction, final_extraction
        ),
        prompt_version=EXTRACTION_VALIDATION_PROMPT_VERSION,
        created_by_id=created_by_id,
        priority=priority,
        force=force,
        bulk_id=bulk_id,
        document=document,
        extraction=extraction,
        final_extraction=final_extraction,
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
        _model(db) is None
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
    final_extraction = get_current_final_extraction(db, document.publication_id)
    if final_extraction is not None and project_extractions_completed(
        db, document.project_id
    ):
        validation = queue_extraction_validation(
            db,
            document.publication_id,
            final_extraction=final_extraction,
            created_by_id=created_by_id,
            priority=max(priority, 10),
            extraction=extraction,
            bulk_id=bulk_id,
        )
        if isinstance(validation, LlmExtractionRun):
            queued = validation
    return queued


def backfill_title_abstract(
    db: Session, project_id: str, *, created_by_id: str | None, bulk_id: str
) -> None:
    """Queue missing title/abstract suggestions after the capability is
    turned on, prioritizing publications not yet screened at this stage."""
    decided_ids = set(
        decided_ids_for_stage(db, project_id, ScreeningStage.TITLE_ABSTRACT)
    )
    publication_ids = list(
        db.scalars(
            select(Publication.id).where(
                Publication.project_id == project_id,
                Publication.is_active.is_(True),
                Publication.merged_into_id.is_(None),
            )
        )
    )
    for publication_id in publication_ids:
        priority = 0 if publication_id not in decided_ids else -10
        queue_title_abstract_suggestion(
            db,
            publication_id,
            created_by_id=created_by_id,
            priority=priority,
            bulk_id=bulk_id,
        )


def backfill_full_text(
    db: Session, project_id: str, *, created_by_id: str | None, bulk_id: str
) -> None:
    """Queue missing full-text assistance after the capability is turned on,
    prioritizing publications not yet screened at this stage."""
    included_ids = set(title_abstract_included_ids(db, project_id))
    excluded_ids = set(full_text_excluded_ids(db, project_id))
    decided_ids = set(decided_ids_for_stage(db, project_id, ScreeningStage.FULL_TEXT))
    for publication_id in included_ids - excluded_ids:
        priority = 0 if publication_id not in decided_ids else -10
        queue_full_text_assistance(
            db,
            publication_id,
            created_by_id=created_by_id,
            priority=priority,
            bulk_id=bulk_id,
        )


def backfill_data_extraction(
    db: Session, project_id: str, *, created_by_id: str | None, bulk_id: str
) -> None:
    """Queue missing data extraction after the capability is turned on,
    prioritizing publications not yet manually extracted."""
    included_ids = set(full_text_included_ids(db, project_id))
    completed_ids = set(
        db.scalars(
            select(ExtractionWorkItem.publication_id).where(
                ExtractionWorkItem.project_id == project_id,
                ExtractionWorkItem.status == ExtractionStatus.COMPLETED,
            )
        )
    )
    for publication_id in included_ids:
        priority = 0 if publication_id not in completed_ids else -10
        queue_document_processing(
            db,
            publication_id,
            created_by_id=created_by_id,
            priority=priority,
            bulk_id=bulk_id,
        )


def backfill_extraction_validation(
    db: Session, project_id: str, *, created_by_id: str | None, bulk_id: str
) -> None:
    """Queue extraction validation after the capability is turned on.

    Validation only starts once the whole extraction cohort is complete
    (``project_extractions_completed``), so there's no "not yet screened"
    subset to prioritize -- every completed extraction is equally ready.
    """
    queue_project_extraction_validations(
        db,
        project_id,
        created_by_id=created_by_id,
        priority=0,
        bulk_id=bulk_id,
    )


def queue_project_title_abstract_reanalysis(
    db: Session, project_id: str, *, created_by_id: str | None, priority: int, bulk_id: str
) -> int:
    """Force-queue title/abstract screening for every active publication in
    the project, for a manager-triggered bulk re-analysis (as opposed to
    backfill_title_abstract, which only queues what's missing)."""
    publication_ids = list(
        db.scalars(
            select(Publication.id).where(
                Publication.project_id == project_id,
                Publication.is_active.is_(True),
                Publication.merged_into_id.is_(None),
            )
        )
    )
    queued = 0
    for publication_id in publication_ids:
        result = queue_title_abstract_suggestion(
            db,
            publication_id,
            created_by_id=created_by_id,
            priority=priority,
            force=True,
            bulk_id=bulk_id,
        )
        if result is not None:
            queued += 1
    return queued


def queue_project_full_text_reanalysis(
    db: Session, project_id: str, *, created_by_id: str | None, priority: int, bulk_id: str
) -> int:
    """Force-queue full-text screening assistance for the project's
    currently title/abstract-included, not-yet-full-text-excluded cohort."""
    included_ids = set(title_abstract_included_ids(db, project_id))
    excluded_ids = set(full_text_excluded_ids(db, project_id))
    queued = 0
    for publication_id in included_ids - excluded_ids:
        result = queue_full_text_assistance(
            db,
            publication_id,
            created_by_id=created_by_id,
            priority=priority,
            force=True,
            bulk_id=bulk_id,
        )
        if result is not None:
            queued += 1
    return queued


def queue_project_data_extraction_reanalysis(
    db: Session, project_id: str, *, created_by_id: str | None, priority: int, bulk_id: str
) -> int:
    """Force-queue data extraction for the project's full-text-included
    cohort: text preparation, and (once completed text is available) the
    extraction run itself."""
    from app.llm.service import queue_llm_run_after_text, queue_preparation_if_eligible

    queued = 0
    for publication_id in full_text_included_ids(db, project_id):
        result = queue_preparation_if_eligible(
            db,
            publication_id,
            created_by_id=created_by_id,
            priority=priority,
            bulk_id=bulk_id,
        )
        document = active_document(db, publication_id)
        if document:
            extraction = db.scalar(
                select(DocumentTextExtraction).where(
                    DocumentTextExtraction.document_id == document.id,
                    DocumentTextExtraction.status == ProcessingStatus.COMPLETED,
                )
            )
            if extraction:
                result = queue_llm_run_after_text(
                    db,
                    extraction,
                    created_by_id=created_by_id,
                    priority=priority,
                    force=True,
                    bulk_id=bulk_id,
                )
        if result is not None:
            queued += 1
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
            data_extraction_fingerprint(db, document, extraction, schema.id)
            if schema
            else None
        )
    final_extraction = get_current_final_extraction(db, publication.id)
    return (
        validation_fingerprint(db, document, extraction, final_extraction)
        if final_extraction
        else None
    )


def run_is_stale(db: Session, run: LlmExtractionRun) -> bool:
    current = current_task_fingerprint(db, run)
    return current is None or current != run.input_fingerprint


def was_cancelled(db: Session, run: LlmExtractionRun) -> bool:
    """Re-check a run's status from the database.

    ``_commit_started``/the equivalent in ``extraction.py`` commits and
    releases the transaction before the (possibly minutes-long) Ollama call,
    so a capability toggled off meanwhile can mark the run ``CANCELLED``
    concurrently. Call this right before persisting a result so that
    cancellation wins instead of being silently overwritten.
    """
    db.refresh(run, attribute_names=["status"])
    return run.status == ProcessingStatus.CANCELLED
