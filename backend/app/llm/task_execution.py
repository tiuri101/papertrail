from __future__ import annotations

import json
import logging
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.api.errors import DomainError
from app.audit.service import record_audit
from app.core.config import get_settings
from app.extraction.models import ExtractionResponse
from app.forms.models import FormField
from app.jobs.errors import TransientJobError
from app.jobs.models import BackgroundJob
from app.llm.evidence import verify_evidence
from app.llm.models import (
    CriterionAssessment,
    DocumentPageText,
    DocumentTextExtraction,
    EvidenceStatus,
    LlmCriterionSuggestion,
    LlmExtractionRun,
    LlmTaskType,
    LlmValidationResult,
    ProcessingStatus,
    ValidationAssessment,
)
from app.llm.ollama import (
    OllamaClientProtocol,
    OllamaResponseError,
    OllamaTransientError,
    create_ollama_client,
)
from app.llm.prompt import chunk_pages
from app.llm.structured import add_metrics, validated_chat
from app.llm.task_prompt import (
    full_text_messages,
    screening_consolidation_messages,
    screening_output_schema,
    title_abstract_messages,
    validation_consolidation_messages,
    validation_messages,
    validation_output_schema,
)
from app.llm.task_service import active_criteria, current_task_fingerprint
from app.llm.task_validation import (
    ExtractionValidationResult,
    ScreeningTaskResult,
    validate_extraction_validation,
    validate_screening_result,
)
from app.projects.models import Criterion
from app.publications.models import Publication

logger = logging.getLogger(__name__)


def _pages(db: Session, extraction_id: str) -> list[DocumentPageText]:
    return list(
        db.scalars(
            select(DocumentPageText)
            .where(DocumentPageText.text_extraction_id == extraction_id)
            .order_by(DocumentPageText.page_number)
        )
    )


def _consolidate[TaskResult: (ScreeningTaskResult, ExtractionValidationResult)](
    *,
    client: OllamaClientProtocol,
    candidates: list[dict[str, Any]],
    schema: dict[str, Any],
    validator: Callable[[dict[str, Any]], TaskResult],
    messages: Callable[[list[dict[str, Any]]], list[dict[str, str]]],
    metrics: dict[str, int],
    context_length: int,
) -> TaskResult:
    current = candidates
    char_budget = max(4000, context_length * 2)
    while len(current) > 1:
        batches: list[list[dict[str, Any]]] = []
        batch: list[dict[str, Any]] = []
        size = 0
        for candidate in current:
            candidate_size = len(json.dumps(candidate, ensure_ascii=False))
            if batch and size + candidate_size > char_budget:
                batches.append(batch)
                batch, size = [], 0
            batch.append(candidate)
            size += candidate_size
        if batch:
            batches.append(batch)
        if len(batches) == len(current):
            batches = [
                current[index : index + 2] for index in range(0, len(current), 2)
            ]
        next_round: list[dict[str, Any]] = []
        for candidate_batch in batches:
            if len(candidate_batch) == 1:
                next_round.append(candidate_batch[0])
                continue
            parsed, response = validated_chat(
                client, messages(candidate_batch), schema, validator
            )
            add_metrics(metrics, response)
            next_round.append(parsed.model_dump(mode="json"))
        current = next_round
    return validator(current[0])


def _mark_started(run: LlmExtractionRun) -> None:
    run.status = ProcessingStatus.PROCESSING
    run.started_at = datetime.now(UTC)
    run.error_type = None
    run.error_message = None


def _mark_failed(
    run: LlmExtractionRun, error_type: str, message: str
) -> dict[str, Any]:
    run.status = ProcessingStatus.FAILED
    run.error_type = error_type
    run.error_message = message[:2000]
    run.completed_at = datetime.now(UTC)
    return {"runId": run.id, "status": "failed", "error": run.error_message}


def _finish(
    db: Session,
    run: LlmExtractionRun,
    result: dict[str, Any],
    metrics: dict[str, int],
) -> None:
    run.raw_result = result
    run.status = ProcessingStatus.COMPLETED
    run.completed_at = datetime.now(UTC)
    for key, value in metrics.items():
        setattr(run, key, value)
    record_audit(
        db,
        action=f"llm.{run.task_type}.generated",
        entity_type="llm_run",
        entity_id=run.id,
        project_id=run.project_id,
        actor_id=None,
        summary=f"Generated {run.task_type.replace('_', ' ')} assistance",
        metadata={
            "publicationId": run.publication_id,
            "taskType": run.task_type,
            "model": run.model,
            "promptVersion": run.prompt_template_version,
        },
    )
    logger.info(
        "Completed LLM task run_id=%s project_id=%s publication_id=%s task_type=%s "
        "model=%s prompt_version=%s prompt_tokens=%s generated_tokens=%s",
        run.id,
        run.project_id,
        run.publication_id,
        run.task_type,
        run.model,
        run.prompt_template_version,
        run.prompt_eval_count,
        run.eval_count,
    )


def _store_criteria(
    db: Session,
    run: LlmExtractionRun,
    criteria: list[Criterion],
    result: ScreeningTaskResult,
    pages: dict[int, str] | None,
) -> None:
    config = get_settings()
    db.execute(
        delete(LlmCriterionSuggestion).where(LlmCriterionSuggestion.run_id == run.id)
    )
    for criterion in criteria:
        item = result.criteria[criterion.id]
        evidence: list[dict[str, Any]]
        if pages is None:
            evidence, evidence_status = [], EvidenceStatus.NOT_REQUIRED
        else:
            evidence, evidence_status = verify_evidence(
                [entry.model_dump() for entry in item.evidence],
                pages,
                required=True,
                max_items=config.llm_max_evidence_items,
                max_quote_chars=config.llm_max_evidence_quote_chars,
            )
        db.add(
            LlmCriterionSuggestion(
                run_id=run.id,
                criterion_id=criterion.id,
                criterion_text=criterion.text,
                criterion_kind=criterion.kind.value,
                assessment=CriterionAssessment(item.assessment),
                explanation=item.explanation,
                evidence=evidence,
                evidence_validation_status=evidence_status,
            )
        )


def _run_title_abstract(db: Session, run: LlmExtractionRun) -> dict[str, Any]:
    publication = db.get(Publication, run.publication_id)
    if publication is None:
        return _mark_failed(run, "publication_missing", "Publication is unavailable")
    criteria = active_criteria(db, run.project_id)
    config = get_settings()
    schema = screening_output_schema(
        [item.id for item in criteria],
        max_evidence=0,
        max_quote=config.llm_max_evidence_quote_chars,
    )
    _mark_started(run)
    db.flush()
    metrics: dict[str, int] = {}
    try:
        result, response = validated_chat(
            create_ollama_client(),
            title_abstract_messages(publication, criteria),
            schema,
            lambda payload: validate_screening_result(
                payload, {item.id for item in criteria}
            ),
        )
        add_metrics(metrics, response)
    except OllamaTransientError as exc:
        raise TransientJobError(str(exc)) from exc
    except (OllamaResponseError, DomainError) as exc:
        return _mark_failed(run, "invalid_response", str(exc))
    _store_criteria(db, run, criteria, result, None)
    payload = result.model_dump(mode="json")
    _finish(db, run, payload, metrics)
    db.flush()
    return {"runId": run.id, "status": "completed", "chunks": 0}


def _run_full_text(db: Session, run: LlmExtractionRun) -> dict[str, Any]:
    publication = db.get(Publication, run.publication_id)
    extraction = (
        db.get(DocumentTextExtraction, run.text_extraction_id)
        if run.text_extraction_id
        else None
    )
    if (
        publication is None
        or extraction is None
        or extraction.status != ProcessingStatus.COMPLETED
    ):
        return _mark_failed(
            run, "text_unavailable", "Extracted PDF text is unavailable"
        )
    page_rows = _pages(db, extraction.id)
    criteria = active_criteria(db, run.project_id)
    config = get_settings()
    criterion_ids = [item.id for item in criteria]
    schema = screening_output_schema(
        criterion_ids,
        max_evidence=config.llm_max_evidence_items,
        max_quote=config.llm_max_evidence_quote_chars,
    )
    chunks = chunk_pages(
        [(page.page_number, page.text) for page in page_rows],
        context_length=config.llm_context_length,
        instruction_chars=sum(len(item.text) for item in criteria),
        field_count=len(criteria),
    )
    _mark_started(run)
    db.flush()
    client = create_ollama_client()
    metrics: dict[str, int] = {}

    def validator(payload: dict[str, Any]) -> ScreeningTaskResult:
        return validate_screening_result(payload, set(criterion_ids))

    try:
        candidates = []
        for chunk in chunks:
            result, response = validated_chat(
                client,
                full_text_messages(publication, criteria, chunk),
                schema,
                validator,
            )
            add_metrics(metrics, response)
            candidates.append(result.model_dump(mode="json"))
        final = _consolidate(
            client=client,
            candidates=candidates,
            schema=schema,
            validator=validator,
            messages=lambda batch: screening_consolidation_messages(criteria, batch),
            metrics=metrics,
            context_length=config.llm_context_length,
        )
    except OllamaTransientError as exc:
        raise TransientJobError(str(exc)) from exc
    except (OllamaResponseError, DomainError) as exc:
        return _mark_failed(run, "invalid_response", str(exc))
    page_map = {page.page_number: page.text for page in page_rows}
    _store_criteria(db, run, criteria, final, page_map)
    payload = final.model_dump(mode="json")
    _finish(db, run, payload, metrics)
    db.flush()
    return {"runId": run.id, "status": "completed", "chunks": len(chunks)}


def _validation_fields(
    db: Session, response: ExtractionResponse
) -> list[dict[str, Any]]:
    fields = {
        item.stable_key: item
        for item in db.scalars(
            select(FormField).where(
                FormField.form_version_id == response.form_version_id
            )
        )
    }
    return [
        {
            "fieldKey": key,
            "label": fields[key].label if key in fields else key,
            "type": fields[key].field_type.value if key in fields else "unknown",
            "humanValue": value,
        }
        for key, value in response.answers.items()
    ]


def _run_validation(db: Session, run: LlmExtractionRun) -> dict[str, Any]:
    response = (
        db.get(ExtractionResponse, run.extraction_response_id)
        if run.extraction_response_id
        else None
    )
    extraction = (
        db.get(DocumentTextExtraction, run.text_extraction_id)
        if run.text_extraction_id
        else None
    )
    if (
        response is None
        or extraction is None
        or extraction.status != ProcessingStatus.COMPLETED
    ):
        return _mark_failed(
            run,
            "source_unavailable",
            "Extraction response or PDF text is unavailable",
        )
    fields = _validation_fields(db, response)
    field_keys = [str(item["fieldKey"]) for item in fields]
    pages = _pages(db, extraction.id)
    config = get_settings()
    schema = validation_output_schema(
        field_keys,
        max_evidence=config.llm_max_evidence_items,
        max_quote=config.llm_max_evidence_quote_chars,
    )
    chunks = chunk_pages(
        [(page.page_number, page.text) for page in pages],
        context_length=config.llm_context_length,
        instruction_chars=len(json.dumps(fields, ensure_ascii=False)),
        field_count=len(fields),
    )
    _mark_started(run)
    db.flush()
    client = create_ollama_client()
    metrics: dict[str, int] = {}

    def validator(payload: dict[str, Any]) -> ExtractionValidationResult:
        return validate_extraction_validation(payload, set(field_keys))

    try:
        candidates = []
        for chunk in chunks:
            result, response_metadata = validated_chat(
                client, validation_messages(fields, chunk), schema, validator
            )
            add_metrics(metrics, response_metadata)
            candidates.append(result.model_dump(mode="json"))
        final = _consolidate(
            client=client,
            candidates=candidates,
            schema=schema,
            validator=validator,
            messages=lambda batch: validation_consolidation_messages(fields, batch),
            metrics=metrics,
            context_length=config.llm_context_length,
        )
    except OllamaTransientError as exc:
        raise TransientJobError(str(exc)) from exc
    except (OllamaResponseError, DomainError) as exc:
        return _mark_failed(run, "invalid_response", str(exc))
    page_map = {page.page_number: page.text for page in pages}
    db.execute(delete(LlmValidationResult).where(LlmValidationResult.run_id == run.id))
    field_map = {str(item["fieldKey"]): item for item in fields}
    for key, item in final.fields.items():
        evidence, evidence_status = verify_evidence(
            [entry.model_dump() for entry in item.evidence],
            page_map,
            required=item.assessment != "not_verifiable",
            max_items=config.llm_max_evidence_items,
            max_quote_chars=config.llm_max_evidence_quote_chars,
        )
        definition = field_map[key]
        db.add(
            LlmValidationResult(
                run_id=run.id,
                extraction_field_key=key,
                field_label=str(definition["label"]),
                value_snapshot=definition["humanValue"],
                assessment=ValidationAssessment(item.assessment),
                explanation=item.explanation,
                evidence=evidence,
                evidence_validation_status=evidence_status,
            )
        )
    payload = final.model_dump(mode="json")
    _finish(db, run, payload, metrics)
    db.flush()
    return {"runId": run.id, "status": "completed", "chunks": len(chunks)}


def run_llm_task_job(db: Session, job: BackgroundJob) -> dict[str, Any]:
    run = db.get(LlmExtractionRun, str(job.payload["run_id"]))
    if run is None:
        return {"status": "cancelled", "reason": "run_missing"}
    if run.status == ProcessingStatus.COMPLETED:
        return {"runId": run.id, "idempotent": True}
    current_fingerprint = current_task_fingerprint(db, run)
    if current_fingerprint is None or current_fingerprint != run.input_fingerprint:
        run.status = ProcessingStatus.STALE
        run.completed_at = datetime.now(UTC)
        db.flush()
        return {"runId": run.id, "status": "stale"}
    if run.task_type == LlmTaskType.TITLE_ABSTRACT_SCREENING:
        return _run_title_abstract(db, run)
    if run.task_type == LlmTaskType.FULL_TEXT_SCREENING:
        return _run_full_text(db, run)
    if run.task_type == LlmTaskType.EXTRACTION_VALIDATION:
        return _run_validation(db, run)
    from app.llm.extraction import run_llm_extraction_job

    return run_llm_extraction_job(db, job)
