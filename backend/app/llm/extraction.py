from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import delete, select
from sqlalchemy.orm import Session, selectinload

from app.api.errors import DomainError
from app.fulltext.models import PublicationDocument
from app.jobs.errors import TransientJobError
from app.jobs.models import BackgroundJob
from app.llm.evidence import verify_evidence
from app.llm.installation_settings import effective_llm_settings
from app.llm.models import (
    DocumentPageText,
    DocumentTextExtraction,
    LlmExtractionRun,
    LlmFieldSuggestion,
    LlmSchemaField,
    LlmSchemaVersion,
    LlmTaskType,
    ProcessingStatus,
    SuggestionStatus,
)
from app.llm.ollama import (
    OllamaClientProtocol,
    OllamaResponse,
    OllamaResponseError,
    OllamaTransientError,
    create_ollama_client,
    with_attempt_sampling,
)
from app.llm.prompt import (
    chunk_pages,
    consolidation_messages,
    extraction_messages,
    field_instructions,
    output_schema,
)
from app.llm.service import full_text_excluded, title_abstract_included
from app.llm.structured import add_metrics, validated_chat
from app.llm.task_service import active_research_questions, was_cancelled
from app.llm.validation import ExtractionResult, validate_result
from app.projects.models import Project, ResearchQuestion


def _validated_chat(
    client: OllamaClientProtocol,
    messages: list[dict[str, str]],
    schema: dict[str, Any],
    fields: list[LlmSchemaField],
) -> tuple[ExtractionResult, OllamaResponse]:
    return validated_chat(
        client,
        messages,
        schema,
        lambda payload: validate_result(payload, fields),
    )


def _consolidate_candidates(
    client: OllamaClientProtocol,
    candidates: list[dict[str, Any]],
    schema: dict[str, Any],
    fields: list[LlmSchemaField],
    research_questions: list[ResearchQuestion],
    metrics: dict[str, int],
    context_length: int,
    custom_instructions: str | None = None,
    base_prompt: str | None = None,
) -> ExtractionResult:
    current = candidates
    instruction_tokens = (
        len(field_instructions(fields))
        + sum(len(item.text) for item in research_questions)
    ) // 3
    response_tokens = max(1200, len(fields) * 300)
    char_budget = max(4000, (context_length - instruction_tokens - response_tokens) * 3)
    while len(current) > 1:
        batches: list[list[dict[str, Any]]] = []
        batch: list[dict[str, Any]] = []
        batch_chars = 0
        for candidate in current:
            candidate_chars = len(json.dumps(candidate, ensure_ascii=False))
            if batch and batch_chars + candidate_chars > char_budget:
                batches.append(batch)
                batch, batch_chars = [], 0
            batch.append(candidate)
            batch_chars += candidate_chars
        if batch:
            batches.append(batch)
        if len(batches) == len(current) and len(current) > 1:
            batches = [
                current[index : index + 2] for index in range(0, len(current), 2)
            ]
        next_round: list[dict[str, Any]] = []
        for candidate_batch in batches:
            if len(candidate_batch) == 1:
                next_round.append(candidate_batch[0])
                continue
            result, response = _validated_chat(
                client,
                consolidation_messages(
                    fields,
                    research_questions,
                    candidate_batch,
                    custom_instructions,
                    base_prompt,
                ),
                schema,
                fields,
            )
            add_metrics(metrics, response)
            next_round.append(result.model_dump(mode="json"))
        current = next_round
    return validate_result(current[0], fields)


def run_llm_extraction_job(db: Session, job: BackgroundJob) -> dict[str, Any]:
    run = db.scalar(
        select(LlmExtractionRun)
        .options(selectinload(LlmExtractionRun.suggestions))
        .where(LlmExtractionRun.id == str(job.payload["run_id"]))
    )
    if run is None:
        return {"status": "cancelled", "reason": "run_missing"}
    if run.task_type != LlmTaskType.DATA_EXTRACTION:
        return {"status": "cancelled", "reason": "wrong_task_type"}
    if run.status == ProcessingStatus.COMPLETED:
        return {"runId": run.id, "idempotent": True}
    project = db.get(Project, run.project_id)
    custom_instructions = project.extraction_prompt_instructions if project else None
    document = db.get(PublicationDocument, run.document_id) if run.document_id else None
    if (
        document is None
        or not document.is_active
        or not title_abstract_included(db, run.publication_id)
        or full_text_excluded(db, run.publication_id)
    ):
        run.status = ProcessingStatus.CANCELLED
        run.completed_at = datetime.now(UTC)
        db.flush()
        return {"runId": run.id, "status": "cancelled"}
    extraction = (
        db.get(DocumentTextExtraction, run.text_extraction_id)
        if run.text_extraction_id
        else None
    )
    if extraction is None or extraction.status != ProcessingStatus.COMPLETED:
        run.status = ProcessingStatus.FAILED
        run.error_type = "text_unavailable"
        run.error_message = "Extracted PDF text is unavailable"
        run.completed_at = datetime.now(UTC)
        db.flush()
        return {"runId": run.id, "status": "failed"}
    if run.schema_version_id is None:
        run.status = ProcessingStatus.FAILED
        run.error_type = "schema_missing"
        run.error_message = "LLM schema version is unavailable"
        run.completed_at = datetime.now(UTC)
        db.flush()
        return {"runId": run.id, "status": "failed"}
    schema_version = db.scalar(
        select(LlmSchemaVersion)
        .options(selectinload(LlmSchemaVersion.fields))
        .where(LlmSchemaVersion.id == run.schema_version_id)
    )
    if schema_version is None:
        run.status = ProcessingStatus.FAILED
        run.error_type = "schema_missing"
        run.error_message = "The LLM schema version no longer exists"
        run.completed_at = datetime.now(UTC)
        db.flush()
        return {"runId": run.id, "status": "failed"}
    fields = [field for field in schema_version.fields if field.enabled]
    research_questions = active_research_questions(db, run.project_id)
    pages = list(
        db.scalars(
            select(DocumentPageText)
            .where(DocumentPageText.text_extraction_id == extraction.id)
            .order_by(DocumentPageText.page_number)
        )
    )
    config = effective_llm_settings(db)
    schema = output_schema(
        fields, config.llm_max_evidence_items, config.llm_max_evidence_quote_chars
    )
    chunks = chunk_pages(
        [(page.page_number, page.text) for page in pages],
        context_length=config.llm_context_length,
        instruction_chars=len(field_instructions(fields))
        + sum(len(item.text) for item in research_questions),
        field_count=len(fields),
    )
    run.model_configuration = with_attempt_sampling(
        run.model_configuration, job.attempts
    )
    run.status = ProcessingStatus.PROCESSING
    run.started_at = datetime.now(UTC)
    run.error_type = None
    run.error_message = None
    # Ollama calls can take minutes. Commit the processing state first so the
    # transaction does not retain run and foreign-key locks during inference.
    db.commit()
    metrics: dict[str, int] = {}
    try:
        client = create_ollama_client(attempt=job.attempts)
        candidates: list[dict[str, Any]] = []
        for chunk in chunks:
            result, response = _validated_chat(
                client,
                extraction_messages(
                    fields,
                    research_questions,
                    chunk,
                    custom_instructions,
                    config.llm_extraction_base_prompt,
                ),
                schema,
                fields,
            )
            candidates.append(result.model_dump(mode="json"))
            add_metrics(metrics, response)
        final = _consolidate_candidates(
            client,
            candidates,
            schema,
            fields,
            research_questions,
            metrics,
            config.llm_context_length,
            custom_instructions,
            config.llm_extraction_base_prompt,
        )
    except OllamaTransientError as exc:
        raise TransientJobError(str(exc)) from exc
    except (OllamaResponseError, DomainError) as exc:
        run.status = ProcessingStatus.FAILED
        run.error_type = "invalid_response"
        run.error_message = str(exc)[:2000]
        run.completed_at = datetime.now(UTC)
        db.flush()
        return {"runId": run.id, "status": "failed", "error": run.error_message}

    if was_cancelled(db, run):
        return {"runId": run.id, "status": "cancelled"}

    page_map = {page.page_number: page.text for page in pages}
    field_map = {field.stable_key: field for field in fields}
    db.execute(delete(LlmFieldSuggestion).where(LlmFieldSuggestion.run_id == run.id))
    for key, field_result in final.fields.items():
        field = field_map[key]
        evidence, evidence_status = verify_evidence(
            [item.model_dump() for item in field_result.evidence],
            page_map,
            required=field.evidence_required,
            max_items=config.llm_max_evidence_items,
            max_quote_chars=config.llm_max_evidence_quote_chars,
        )
        db.add(
            LlmFieldSuggestion(
                run_id=run.id,
                schema_field_id=field.id,
                mapped_extraction_field_key=field.mapped_extraction_field_key,
                value=field_result.value,
                status=SuggestionStatus(field_result.status),
                evidence=evidence,
                evidence_validation_status=evidence_status,
            )
        )
    run.raw_result = final.model_dump(mode="json")
    run.status = ProcessingStatus.COMPLETED
    run.completed_at = datetime.now(UTC)
    for key, value in metrics.items():
        setattr(run, key, value)
    db.flush()
    return {
        "runId": run.id,
        "status": "completed",
        "chunks": len(chunks),
        "suggestions": len(fields),
    }
