from __future__ import annotations

from collections import Counter
from typing import Any
from urllib.parse import urlsplit, urlunsplit
from uuid import uuid4

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from app.accounts.dependencies import get_current_user, require_csrf
from app.accounts.models import User, UserSession
from app.api.errors import DomainError, ForbiddenError, NotFoundError
from app.audit.service import record_audit
from app.conflicts.models import FinalDecision
from app.core.config import get_settings
from app.db.session import get_db
from app.extraction.models import ExtractionResponse, ExtractionWorkItem
from app.forms.schemas import FieldResponse
from app.fulltext.documents import active_document
from app.fulltext.models import PublicationDocument
from app.jobs.models import BackgroundJob
from app.llm.models import (
    DocumentTextExtraction,
    LlmExtractionRun,
    LlmSchemaVersion,
    LlmTaskType,
    ProcessingStatus,
)
from app.llm.ollama import OllamaError, create_ollama_client
from app.llm.schema_service import (
    active_extraction_fields,
    current_schema,
    initialize_from_form,
    latest_schema,
    mapping_state,
    project_settings,
    publish_schema,
    update_schema_fields,
)
from app.llm.schemas import (
    AssistanceResponse,
    ExtractionValidationResponse,
    LlmSchemaUpdate,
    LlmSettingsUpdate,
    ManualRunRequest,
    ReanalysisRequest,
    ScreeningAssistanceResponse,
    ValidationReviewResponse,
)
from app.llm.service import (
    cancel_task_type_jobs,
    latest_current_run,
    queue_llm_run_after_text,
    queue_preparation_if_eligible,
)
from app.llm.task_service import (
    backfill_data_extraction,
    backfill_extraction_validation,
    backfill_full_text,
    backfill_title_abstract,
    current_validation_run,
    feature_enabled,
    latest_task_run,
    project_extractions_completed,
    project_validation_progress,
    queue_extraction_validation,
    queue_full_text_assistance,
    queue_project_extraction_validations,
    queue_title_abstract_suggestion,
    run_is_stale,
)
from app.llm.task_validation import derive_screening_recommendation
from app.projects.dependencies import (
    require_project_manager,
    require_project_manager_csrf,
)
from app.projects.models import ProjectMembership, ScreeningStage
from app.projects.service import is_project_manager, require_project_access
from app.publications.models import Publication
from app.screening.models import ScreeningDecision, ScreeningOutcome, ScreeningWorkItem

router = APIRouter(tags=["LLM-assisted extraction"])


def _public_endpoint(value: str | None) -> str | None:
    if value is None:
        return None
    parsed = urlsplit(value)
    host = parsed.hostname or ""
    if parsed.port:
        host = f"{host}:{parsed.port}"
    return urlunsplit((parsed.scheme, host, parsed.path, "", ""))


def _schema_payload(
    db: Session, schema: LlmSchemaVersion | None
) -> dict[str, Any] | None:
    if schema is None:
        return None
    return {
        "id": schema.id,
        "versionNumber": schema.version_number,
        "status": schema.status,
        "basedOnFormVersionId": schema.based_on_form_version_id,
        "publishedAt": schema.published_at,
        "fields": [
            {
                "id": field.id,
                "stableKey": field.stable_key,
                "label": field.label,
                "instruction": field.instruction,
                "fieldType": field.field_type,
                "mappedExtractionFieldKey": field.mapped_extraction_field_key,
                "options": field.options,
                "evidenceRequired": field.evidence_required,
                "allowInferred": field.allow_inferred,
                "enabled": field.enabled,
                "position": field.position,
                "mappingState": mapping_state(db, schema.project_id, field),
            }
            for field in sorted(schema.fields, key=lambda item: item.position)
        ],
    }


@router.get("/projects/{project_id}/llm/settings")
def get_llm_settings(
    project_id: str,
    _: User = Depends(require_project_manager),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    config = get_settings()
    settings = project_settings(db, project_id)
    return {
        "enabled": bool(settings and settings.enabled),
        "titleAbstractScreeningEnabled": bool(
            settings and settings.title_abstract_screening_enabled
        ),
        "fullTextScreeningEnabled": bool(
            settings and settings.full_text_screening_enabled
        ),
        "extractionValidationEnabled": bool(
            settings and settings.extraction_validation_enabled
        ),
        "installationEnabled": config.llm_enabled,
        "provider": "Ollama",
        "endpoint": _public_endpoint(config.ollama_base_url),
        "model": config.ollama_model,
        "contextLength": config.llm_context_length,
        "currentSchemaVersionId": (
            settings.current_schema_version_id if settings else None
        ),
    }


# Each toggleable capability: which task type its jobs run as, and how to
# backfill it once turned on (prioritizing publications not yet at that
# stage's decision/extraction -- see the individual backfill_* docstrings).
_CAPABILITY_TASK_TYPES: dict[str, LlmTaskType] = {
    "title_abstract_screening_enabled": LlmTaskType.TITLE_ABSTRACT_SCREENING,
    "full_text_screening_enabled": LlmTaskType.FULL_TEXT_SCREENING,
    "enabled": LlmTaskType.DATA_EXTRACTION,
    "extraction_validation_enabled": LlmTaskType.EXTRACTION_VALIDATION,
}
_CAPABILITY_BACKFILL = {
    "title_abstract_screening_enabled": backfill_title_abstract,
    "full_text_screening_enabled": backfill_full_text,
    "enabled": backfill_data_extraction,
    "extraction_validation_enabled": backfill_extraction_validation,
}


@router.patch("/projects/{project_id}/llm/settings")
def update_llm_settings(
    project_id: str,
    payload: LlmSettingsUpdate,
    manager: User = Depends(require_project_manager_csrf),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    changes = payload.model_dump(exclude_none=True)
    if any(changes.values()) and not get_settings().llm_enabled:
        raise DomainError("LLM support is disabled for this Papertrail installation")
    settings = project_settings(db, project_id, create=True)
    assert settings is not None
    before = {key: getattr(settings, key) for key in _CAPABILITY_TASK_TYPES}
    for key, value in changes.items():
        setattr(settings, key, value)
    settings.updated_by_user_id = manager.id
    record_audit(
        db,
        action="llm.settings_updated",
        entity_type="project_llm_settings",
        entity_id=settings.id,
        project_id=project_id,
        actor_id=manager.id,
        summary="Updated project LLM assistance settings",
        metadata={"changes": changes},
    )
    bulk_id = str(uuid4())
    for key, task_type in _CAPABILITY_TASK_TYPES.items():
        if key not in changes or before[key] == getattr(settings, key):
            continue
        if getattr(settings, key):
            # Just turned on: backfill the eligible cohort, unscreened first.
            _CAPABILITY_BACKFILL[key](
                db, project_id, created_by_id=manager.id, bulk_id=bulk_id
            )
        else:
            # Just turned off: stop the flow of new suggestions for this
            # stage. Queued jobs are cancelled outright; an in-flight job's
            # result is discarded when the worker notices via was_cancelled.
            cancel_task_type_jobs(db, project_id, task_type)
    db.commit()
    return {
        "enabled": settings.enabled,
        "titleAbstractScreeningEnabled": settings.title_abstract_screening_enabled,
        "fullTextScreeningEnabled": settings.full_text_screening_enabled,
        "extractionValidationEnabled": settings.extraction_validation_enabled,
    }


@router.post("/projects/{project_id}/llm/test")
def test_ollama_connection(
    project_id: str,
    _: User = Depends(require_project_manager_csrf),
) -> dict[str, Any]:
    try:
        return create_ollama_client().test_connection()
    except OllamaError as exc:
        return {"available": False, "modelAvailable": False, "error": str(exc)}


@router.get("/projects/{project_id}/llm/schema")
def get_llm_schema(
    project_id: str,
    _: User = Depends(require_project_manager),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    latest = latest_schema(db, project_id)
    fields = [
        FieldResponse.model_validate(field)
        for field in active_extraction_fields(db, project_id)
    ]
    return {"schema": _schema_payload(db, latest), "extractionFields": fields}


@router.post("/projects/{project_id}/llm/schema/from-extraction-form")
def create_llm_schema(
    project_id: str,
    manager: User = Depends(require_project_manager_csrf),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    schema = initialize_from_form(db, project_id, manager.id)
    db.commit()
    return _schema_payload(db, schema) or {}


def _project_schema(db: Session, project_id: str, schema_id: str) -> LlmSchemaVersion:
    schema = db.scalar(
        select(LlmSchemaVersion)
        .options(selectinload(LlmSchemaVersion.fields))
        .where(
            LlmSchemaVersion.id == schema_id, LlmSchemaVersion.project_id == project_id
        )
    )
    if schema is None:
        raise NotFoundError("LLM schema version not found")
    return schema


@router.put("/projects/{project_id}/llm/schema/{schema_id}")
def save_llm_schema(
    project_id: str,
    schema_id: str,
    payload: LlmSchemaUpdate,
    manager: User = Depends(require_project_manager_csrf),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    schema = update_schema_fields(
        db,
        _project_schema(db, project_id, schema_id),
        [field.model_dump() for field in payload.fields],
        manager.id,
    )
    db.commit()
    return _schema_payload(db, schema) or {}


@router.post("/projects/{project_id}/llm/schema/{schema_id}/publish")
def publish_llm_schema(
    project_id: str,
    schema_id: str,
    manager: User = Depends(require_project_manager_csrf),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    schema = publish_schema(db, _project_schema(db, project_id, schema_id), manager.id)
    db.commit()
    return _schema_payload(db, schema) or {}


def _can_queue(db: Session, project_id: str, publication_id: str, user: User) -> bool:
    if is_project_manager(db, project_id, user):
        return True
    membership = db.scalar(
        select(ProjectMembership).where(
            ProjectMembership.project_id == project_id,
            ProjectMembership.user_id == user.id,
            ProjectMembership.can_extract.is_(True),
        )
    )
    assigned = db.scalar(
        select(ExtractionWorkItem.id).where(
            ExtractionWorkItem.project_id == project_id,
            ExtractionWorkItem.publication_id == publication_id,
            ExtractionWorkItem.assigned_reviewer_id == user.id,
        )
    )
    return membership is not None and assigned is not None


@router.post("/projects/{project_id}/publications/{publication_id}/llm/run")
def queue_publication_llm_run(
    project_id: str,
    publication_id: str,
    payload: ManualRunRequest,
    session: UserSession = Depends(require_csrf),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    publication = db.get(Publication, publication_id)
    if publication is None or publication.project_id != project_id:
        raise NotFoundError("Publication not found")
    if not _can_queue(db, project_id, publication_id, session.user):
        raise ForbiddenError("Extraction reviewer or project manager access required")
    result = queue_preparation_if_eligible(
        db, publication_id, created_by_id=session.user.id, priority=10
    )
    if payload.force:
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
                    created_by_id=session.user.id,
                    priority=10,
                    force=True,
                )
    if result is None:
        raise DomainError(
            "Publication is not eligible or has no processable active PDF"
        )
    record_audit(
        db,
        action="llm.extraction_rerun" if payload.force else "llm.extraction_queued",
        entity_type="publication",
        entity_id=publication_id,
        project_id=project_id,
        actor_id=session.user.id,
        summary="Manually queued LLM extraction",
    )
    db.commit()
    return {"id": result.id, "status": getattr(result, "status", "queued")}


@router.post("/projects/{project_id}/llm/runs/reanalyze")
def reanalyze_publications(
    project_id: str,
    payload: ReanalysisRequest,
    manager: User = Depends(require_project_manager_csrf),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    try:
        task_type = LlmTaskType(payload.task_type)
    except ValueError as exc:
        raise DomainError("Unsupported re-analysis task type") from exc
    if not feature_enabled(db, project_id, task_type):
        raise DomainError("This LLM capability is disabled for this project")

    bulk_id = str(uuid4())
    queued = 0
    result: LlmExtractionRun | BackgroundJob | None = None

    if task_type == LlmTaskType.TITLE_ABSTRACT_SCREENING:
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
            result = queue_title_abstract_suggestion(
                db,
                publication_id,
                created_by_id=manager.id,
                priority=-10,
                force=True,
                bulk_id=bulk_id,
            )
            if result is not None:
                queued += 1
    elif task_type == LlmTaskType.FULL_TEXT_SCREENING:
        included_ids = set(
            db.scalars(
                select(FinalDecision.publication_id).where(
                    FinalDecision.project_id == project_id,
                    FinalDecision.stage == ScreeningStage.TITLE_ABSTRACT,
                    FinalDecision.outcome == ScreeningOutcome.INCLUDE,
                    FinalDecision.is_valid.is_(True),
                )
            )
        )
        excluded_ids = set(
            db.scalars(
                select(FinalDecision.publication_id).where(
                    FinalDecision.project_id == project_id,
                    FinalDecision.stage == ScreeningStage.FULL_TEXT,
                    FinalDecision.outcome == ScreeningOutcome.EXCLUDE,
                    FinalDecision.is_valid.is_(True),
                )
            )
        )
        for publication_id in included_ids - excluded_ids:
            result = queue_full_text_assistance(
                db,
                publication_id,
                created_by_id=manager.id,
                priority=-10,
                force=True,
                bulk_id=bulk_id,
            )
            if result is not None:
                queued += 1
    elif task_type == LlmTaskType.DATA_EXTRACTION:
        # The Data Extraction stage's actual cohort: publications already
        # included at full-text screening.
        publication_ids = list(
            db.scalars(
                select(FinalDecision.publication_id).where(
                    FinalDecision.project_id == project_id,
                    FinalDecision.stage == ScreeningStage.FULL_TEXT,
                    FinalDecision.outcome == ScreeningOutcome.INCLUDE,
                    FinalDecision.is_valid.is_(True),
                )
            )
        )
        for publication_id in publication_ids:
            result = queue_preparation_if_eligible(
                db,
                publication_id,
                created_by_id=manager.id,
                priority=-10,
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
                        created_by_id=manager.id,
                        priority=-10,
                        force=True,
                        bulk_id=bulk_id,
                    )
            if result is not None:
                queued += 1
    else:
        if not project_extractions_completed(db, project_id):
            raise DomainError(
                "Extraction validation starts after every paper has been "
                "manually extracted"
            )
        results = queue_project_extraction_validations(
            db,
            project_id,
            created_by_id=manager.id,
            priority=-10,
            force=True,
            bulk_id=bulk_id,
        )
        queued = len(results)

    record_audit(
        db,
        action=f"llm.{task_type}.reanalysis_queued",
        entity_type="project",
        entity_id=project_id,
        project_id=project_id,
        actor_id=manager.id,
        summary="Queued project LLM re-analysis",
        metadata={"taskType": task_type, "count": queued, "bulkId": bulk_id},
    )
    db.commit()
    return {"taskType": task_type, "queued": queued, "bulkId": bulk_id}


def _assistance_payload(
    db: Session, project_id: str, publication_id: str
) -> dict[str, Any]:
    if not feature_enabled(db, project_id, LlmTaskType.DATA_EXTRACTION):
        # Disabled always wins, even over an existing (possibly completed)
        # run from before the capability was turned off.
        return {"state": "disabled"}
    run = latest_current_run(db, project_id, publication_id)
    schema = current_schema(db, project_id)
    document = active_document(db, publication_id)
    if run is None and document is not None:
        run = db.scalar(
            select(LlmExtractionRun)
            .options(selectinload(LlmExtractionRun.suggestions))
            .where(
                LlmExtractionRun.project_id == project_id,
                LlmExtractionRun.publication_id == publication_id,
                LlmExtractionRun.document_id == document.id,
                LlmExtractionRun.task_type == LlmTaskType.DATA_EXTRACTION,
            )
            .order_by(LlmExtractionRun.created_at.desc())
        )
    if run is None:
        if document is None:
            return {"state": "missing_pdf"}
        if schema is None:
            return {"state": "no_schema", "documentId": document.id}
        extraction = db.scalar(
            select(DocumentTextExtraction).where(
                DocumentTextExtraction.document_id == document.id
            )
        )
        if extraction and extraction.status in {
            ProcessingStatus.UNSUPPORTED,
            ProcessingStatus.FAILED,
        }:
            return {
                "state": "text_unavailable",
                "documentId": document.id,
                "error": extraction.error_message,
            }
        return {"state": "unavailable", "documentId": document.id}
    run_schema = db.scalar(
        select(LlmSchemaVersion)
        .options(selectinload(LlmSchemaVersion.fields))
        .where(LlmSchemaVersion.id == run.schema_version_id)
    )
    field_by_id = {field.id: field for field in run_schema.fields} if run_schema else {}
    suggestions = []
    for suggestion in run.suggestions:
        field = field_by_id.get(suggestion.schema_field_id)
        if field is None:
            continue
        suggestions.append(
            {
                "id": suggestion.id,
                "schemaFieldId": suggestion.schema_field_id,
                "mappedExtractionFieldKey": suggestion.mapped_extraction_field_key,
                "label": field.label,
                "value": suggestion.value,
                "status": suggestion.status,
                "evidence": suggestion.evidence,
                "evidenceValidationStatus": suggestion.evidence_validation_status,
                "evidenceRequired": field.evidence_required,
                "helper": suggestion.mapped_extraction_field_key is None,
            }
        )
    return {
        "state": "ready" if run.status == ProcessingStatus.COMPLETED else run.status,
        "runId": run.id,
        "documentId": run.document_id,
        "schemaVersion": run_schema.version_number if run_schema else None,
        "model": run.model,
        "outdated": bool(
            (schema and run.schema_version_id != schema.id) or run_is_stale(db, run)
        ),
        "error": run.error_message,
        "suggestions": suggestions,
    }


@router.get(
    "/projects/{project_id}/extraction/{item_id}/llm-suggestions",
    response_model=AssistanceResponse,
)
def extraction_suggestions(
    project_id: str,
    item_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    require_project_access(db, project_id, user)
    item = db.get(ExtractionWorkItem, item_id)
    if item is None or item.project_id != project_id:
        raise NotFoundError("Extraction work item not found")
    if not is_project_manager(db, project_id, user):
        membership = db.scalar(
            select(ProjectMembership).where(
                ProjectMembership.project_id == project_id,
                ProjectMembership.user_id == user.id,
                ProjectMembership.can_extract.is_(True),
            )
        )
        if item.assigned_reviewer_id != user.id or membership is None:
            raise ForbiddenError("Extraction is assigned to another eligible reviewer")
    return _assistance_payload(db, project_id, item.publication_id)


def _assigned_screening_item(
    db: Session, project_id: str, item_id: str, user: User
) -> ScreeningWorkItem:
    require_project_access(db, project_id, user)
    item = db.get(ScreeningWorkItem, item_id)
    if item is None or item.project_id != project_id:
        raise NotFoundError("Screening work item not found")
    if item.assigned_reviewer_id != user.id:
        raise ForbiddenError("Screening work item is assigned to another reviewer")
    membership = db.scalar(
        select(ProjectMembership).where(
            ProjectMembership.project_id == project_id,
            ProjectMembership.user_id == user.id,
        )
    )
    allowed = bool(
        membership
        and (
            membership.can_title_abstract_screen
            if item.stage == ScreeningStage.TITLE_ABSTRACT
            else membership.can_full_text_screen
        )
    )
    if not allowed and not user.is_admin:
        raise ForbiddenError("Eligible assigned screening reviewer access required")
    return item


def _screening_payload(
    db: Session,
    run: LlmExtractionRun | None,
    *,
    project_id: str,
    publication_id: str,
    task_type: LlmTaskType,
) -> dict[str, Any]:
    if not feature_enabled(db, project_id, task_type):
        # Disabled always wins, even over an existing (possibly completed)
        # run from before the capability was turned off.
        return {"state": "disabled"}
    if run is None:
        if task_type == LlmTaskType.FULL_TEXT_SCREENING:
            document = active_document(db, publication_id)
            if document is None:
                return {"state": "missing_pdf"}
            extraction = db.scalar(
                select(DocumentTextExtraction).where(
                    DocumentTextExtraction.document_id == document.id
                )
            )
            if extraction and extraction.status in {
                ProcessingStatus.UNSUPPORTED,
                ProcessingStatus.FAILED,
            }:
                return {
                    "state": "text_unavailable",
                    "documentId": document.id,
                    "error": extraction.error_message,
                }
            if extraction and extraction.status in {
                ProcessingStatus.PENDING,
                ProcessingStatus.PROCESSING,
            }:
                return {"state": "processing", "documentId": document.id}
        return {"state": "unavailable"}
    stale = run_is_stale(db, run)
    raw = run.raw_result or {}
    recommendation = (
        derive_screening_recommendation(
            (item.criterion_kind, item.assessment) for item in run.criterion_suggestions
        )
        if run.status == ProcessingStatus.COMPLETED and run.criterion_suggestions
        else None
    )
    return {
        "state": (
            "ready"
            if run.status == ProcessingStatus.COMPLETED
            else "queued" if run.status == ProcessingStatus.PENDING else run.status
        ),
        "runId": run.id,
        "documentId": run.document_id,
        "model": run.model,
        "promptVersion": run.prompt_template_version,
        "stale": stale,
        "error": run.error_message,
        "suggestedDecision": (
            recommendation.suggested_decision
            if recommendation is not None
            else raw.get("suggested_decision")
        ),
        "confidence": (
            recommendation.confidence
            if recommendation is not None
            else raw.get("confidence")
        ),
        "reasoningSummary": (
            recommendation.reasoning_summary
            if recommendation is not None
            else raw.get("reasoning_summary")
        ),
        "criteria": [
            {
                "criterionId": item.criterion_id,
                "criterionText": item.criterion_text,
                "criterionKind": item.criterion_kind,
                "assessment": item.assessment,
                "explanation": item.explanation,
                "evidence": item.evidence,
                "evidenceValidationStatus": item.evidence_validation_status,
            }
            for item in run.criterion_suggestions
        ],
    }


@router.get(
    "/projects/{project_id}/screening/work-items/{item_id}/llm-title-abstract",
    response_model=ScreeningAssistanceResponse,
)
def title_abstract_suggestion(
    project_id: str,
    item_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    item = _assigned_screening_item(db, project_id, item_id, user)
    if item.stage != ScreeningStage.TITLE_ABSTRACT:
        raise NotFoundError("Title/abstract screening item not found")
    if not feature_enabled(db, project_id, LlmTaskType.TITLE_ABSTRACT_SCREENING):
        # Disabled always wins, even before the reviewer has submitted their
        # own decision — there is nothing to reveal or hide.
        return {"state": "disabled"}
    own_decision = db.scalar(
        select(ScreeningDecision.id).where(
            ScreeningDecision.work_item_id == item.id,
            ScreeningDecision.reviewer_id == user.id,
            ScreeningDecision.is_current.is_(True),
        )
    )
    if own_decision is None:
        # Deliberately reveal no run ID, model, status, decision, or reasoning.
        return {"state": "hidden", "hidden": True}
    run = latest_task_run(db, item.publication_id, LlmTaskType.TITLE_ABSTRACT_SCREENING)
    return _screening_payload(
        db,
        run,
        project_id=project_id,
        publication_id=item.publication_id,
        task_type=LlmTaskType.TITLE_ABSTRACT_SCREENING,
    )


@router.post("/projects/{project_id}/screening/work-items/{item_id}/llm-title-abstract")
def request_title_abstract_suggestion(
    project_id: str,
    item_id: str,
    payload: ManualRunRequest,
    session: UserSession = Depends(require_csrf),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    item = _assigned_screening_item(db, project_id, item_id, session.user)
    if item.stage != ScreeningStage.TITLE_ABSTRACT:
        raise NotFoundError("Title/abstract screening item not found")
    run = queue_title_abstract_suggestion(
        db,
        item.publication_id,
        created_by_id=session.user.id,
        priority=10,
        force=payload.force,
    )
    if run is None:
        raise DomainError("Title/abstract LLM suggestions are disabled")
    record_audit(
        db,
        action=(
            "llm.title_abstract_regenerated"
            if payload.force
            else "llm.title_abstract_queued"
        ),
        entity_type="llm_run",
        entity_id=run.id,
        project_id=project_id,
        actor_id=session.user.id,
        summary="Queued title/abstract LLM suggestion",
        metadata={"publicationId": item.publication_id, "taskType": run.task_type},
    )
    db.commit()
    return {"id": run.id, "status": run.status}


@router.get(
    "/projects/{project_id}/screening/work-items/{item_id}/llm-full-text",
    response_model=ScreeningAssistanceResponse,
)
def full_text_assistance(
    project_id: str,
    item_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    item = _assigned_screening_item(db, project_id, item_id, user)
    if item.stage != ScreeningStage.FULL_TEXT:
        raise NotFoundError("Full-text screening item not found")
    run = latest_task_run(db, item.publication_id, LlmTaskType.FULL_TEXT_SCREENING)
    return _screening_payload(
        db,
        run,
        project_id=project_id,
        publication_id=item.publication_id,
        task_type=LlmTaskType.FULL_TEXT_SCREENING,
    )


@router.post("/projects/{project_id}/screening/work-items/{item_id}/llm-full-text")
def request_full_text_assistance(
    project_id: str,
    item_id: str,
    payload: ManualRunRequest,
    session: UserSession = Depends(require_csrf),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    item = _assigned_screening_item(db, project_id, item_id, session.user)
    if item.stage != ScreeningStage.FULL_TEXT:
        raise NotFoundError("Full-text screening item not found")
    result = queue_full_text_assistance(
        db,
        item.publication_id,
        created_by_id=session.user.id,
        priority=10,
        force=payload.force,
    )
    if result is None:
        raise DomainError(
            "Full-text assistance is disabled or full text is unavailable"
        )
    record_audit(
        db,
        action="llm.full_text_regenerated" if payload.force else "llm.full_text_queued",
        entity_type="llm_run",
        entity_id=result.id,
        project_id=project_id,
        actor_id=session.user.id,
        summary="Queued full-text LLM assistance",
        metadata={"publicationId": item.publication_id},
    )
    db.commit()
    return {"id": result.id, "status": getattr(result, "status", "queued")}


def _assigned_extraction_item(
    db: Session, project_id: str, item_id: str, user: User
) -> ExtractionWorkItem:
    require_project_access(db, project_id, user)
    item = db.get(ExtractionWorkItem, item_id)
    if item is None or item.project_id != project_id:
        raise NotFoundError("Extraction work item not found")
    if item.assigned_reviewer_id != user.id and not is_project_manager(
        db, project_id, user
    ):
        raise ForbiddenError("Extraction is assigned to another reviewer")
    return item


def _validation_payload(db: Session, item: ExtractionWorkItem) -> dict[str, Any]:
    response = db.scalar(
        select(ExtractionResponse)
        .where(
            ExtractionResponse.work_item_id == item.id,
            ExtractionResponse.is_current.is_(True),
        )
        .order_by(ExtractionResponse.created_at.desc())
    )
    if response is None:
        return {"state": "not_submitted"}
    if not feature_enabled(db, item.project_id, LlmTaskType.EXTRACTION_VALIDATION):
        # Disabled always wins, even over an existing (possibly completed)
        # run from before the capability was turned off.
        return {"state": "disabled", "responseId": response.id}
    run = latest_task_run(db, item.publication_id, LlmTaskType.EXTRACTION_VALIDATION)
    if run is None:
        return {"state": "unavailable", "responseId": response.id}
    stale = run_is_stale(db, run)
    return {
        "state": (
            "ready"
            if run.status == ProcessingStatus.COMPLETED
            else "queued" if run.status == ProcessingStatus.PENDING else run.status
        ),
        "runId": run.id,
        "responseId": run.extraction_response_id,
        "model": run.model,
        "promptVersion": run.prompt_template_version,
        "stale": stale,
        "error": run.error_message,
        "results": [
            {
                "fieldKey": result.extraction_field_key,
                "fieldLabel": result.field_label,
                "value": result.value_snapshot,
                "assessment": result.assessment,
                "explanation": result.explanation,
                "evidence": result.evidence,
                "evidenceValidationStatus": result.evidence_validation_status,
            }
            for result in run.validation_results
        ],
    }


def _validation_result_payload(result: Any) -> dict[str, Any]:
    return {
        "fieldKey": result.extraction_field_key,
        "fieldLabel": result.field_label,
        "value": result.value_snapshot,
        "assessment": result.assessment,
        "explanation": result.explanation,
        "evidence": result.evidence,
        "evidenceValidationStatus": result.evidence_validation_status,
    }


@router.get(
    "/projects/{project_id}/llm/extraction-validation-review",
    response_model=ValidationReviewResponse,
)
def extraction_validation_review(
    project_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    require_project_access(db, project_id, user)
    manager = is_project_manager(db, project_id, user)
    if not manager:
        membership = db.scalar(
            select(ProjectMembership).where(
                ProjectMembership.project_id == project_id,
                ProjectMembership.user_id == user.id,
                ProjectMembership.can_extract.is_(True),
            )
        )
        if membership is None:
            raise ForbiddenError(
                "Extraction validation review requires extraction access"
            )
    enabled = feature_enabled(db, project_id, LlmTaskType.EXTRACTION_VALIDATION)
    progress = project_validation_progress(db, project_id)
    query = (
        select(ExtractionWorkItem)
        .where(ExtractionWorkItem.project_id == project_id)
        .order_by(ExtractionWorkItem.random_rank)
    )
    if not manager:
        query = query.where(ExtractionWorkItem.assigned_reviewer_id == user.id)
    items: list[dict[str, Any]] = []
    for item in db.scalars(query):
        response = db.scalar(
            select(ExtractionResponse)
            .where(
                ExtractionResponse.work_item_id == item.id,
                ExtractionResponse.is_current.is_(True),
            )
            .order_by(ExtractionResponse.created_at.desc())
        )
        publication = db.get(Publication, item.publication_id)
        if publication is None:
            continue
        # Disabled always wins, even over an existing (possibly completed)
        # run from before the capability was turned off.
        run = current_validation_run(db, item) if enabled else None
        if response is None:
            state = "waiting_for_extraction"
        elif not enabled:
            state = "disabled"
        elif run is None:
            document = active_document(db, item.publication_id)
            text_extraction = (
                db.scalar(
                    select(DocumentTextExtraction).where(
                        DocumentTextExtraction.document_id == document.id
                    )
                )
                if document is not None
                else None
            )
            state = (
                "unavailable"
                if document is None
                or (
                    text_extraction is not None
                    and text_extraction.status
                    in {ProcessingStatus.FAILED, ProcessingStatus.UNSUPPORTED}
                )
                else "awaiting_validation"
            )
        else:
            state = (
                "ready"
                if run.status == ProcessingStatus.COMPLETED
                else (
                    "queued"
                    if run.status == ProcessingStatus.PENDING
                    else str(run.status)
                )
            )
        items.append(
            {
                "workItemId": item.id,
                "publicationId": item.publication_id,
                "assignedReviewerId": item.assigned_reviewer_id,
                "responseId": response.id if response else None,
                "fullTextAvailable": active_document(db, item.publication_id)
                is not None,
                "state": state,
                "runId": run.id if run else None,
                "model": run.model if run else None,
                "promptVersion": run.prompt_template_version if run else None,
                "error": run.error_message if run else None,
                "publication": {
                    "id": publication.id,
                    "title": publication.title,
                    "authors": publication.authors,
                    "publicationYear": publication.publication_year,
                },
                "results": [
                    _validation_result_payload(result)
                    for result in (run.validation_results if run else [])
                ],
            }
        )
    return {
        "enabled": enabled,
        "progress": {
            "total": progress.total,
            "completed": progress.completed,
            "pending": progress.pending,
            "failed": progress.failed,
            "unavailable": progress.unavailable,
            "outstanding": progress.outstanding,
            "settled": progress.settled,
        },
        "items": items,
    }


@router.get(
    "/projects/{project_id}/extraction/{item_id}/llm-validation",
    response_model=ExtractionValidationResponse,
)
def extraction_validation(
    project_id: str,
    item_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    return _validation_payload(
        db, _assigned_extraction_item(db, project_id, item_id, user)
    )


@router.post("/projects/{project_id}/extraction/{item_id}/llm-validation")
def request_extraction_validation(
    project_id: str,
    item_id: str,
    payload: ManualRunRequest,
    session: UserSession = Depends(require_csrf),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    item = _assigned_extraction_item(db, project_id, item_id, session.user)
    response = db.scalar(
        select(ExtractionResponse).where(
            ExtractionResponse.work_item_id == item.id,
            ExtractionResponse.is_current.is_(True),
        )
    )
    if response is None:
        raise DomainError("Submit the human extraction before validating it")
    if not project_extractions_completed(db, project_id):
        raise DomainError(
            "Extraction validation starts after every paper has been manually extracted"
        )
    result = queue_extraction_validation(
        db,
        item.publication_id,
        response=response,
        created_by_id=session.user.id,
        priority=10,
        force=payload.force,
    )
    if result is None:
        raise DomainError("Extraction validation requires usable full text")
    record_audit(
        db,
        action="llm.extraction_validation_queued",
        entity_type="llm_run",
        entity_id=result.id,
        project_id=project_id,
        actor_id=session.user.id,
        summary="Queued extraction validation",
        metadata={"publicationId": item.publication_id, "responseId": response.id},
    )
    db.commit()
    return {"id": result.id, "status": getattr(result, "status", "queued")}


@router.get("/projects/{project_id}/llm/runs")
def llm_runs(
    project_id: str,
    _: User = Depends(require_project_manager),
    db: Session = Depends(get_db),
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=50, ge=1, le=200),
) -> dict[str, Any]:
    current = current_schema(db, project_id)
    runs = list(
        db.scalars(
            select(LlmExtractionRun)
            .where(LlmExtractionRun.project_id == project_id)
            .order_by(LlmExtractionRun.created_at.desc())
            .offset(offset)
            .limit(limit)
        )
    )
    total = int(
        db.scalar(
            select(func.count())
            .select_from(LlmExtractionRun)
            .where(LlmExtractionRun.project_id == project_id)
        )
        or 0
    )
    counts = Counter(
        db.scalars(
            select(LlmExtractionRun.status).where(
                LlmExtractionRun.project_id == project_id
            )
        )
    )
    completed = [run for run in runs if run.status == ProcessingStatus.COMPLETED]
    eligible_ids = set(
        db.scalars(
            select(FinalDecision.publication_id).where(
                FinalDecision.project_id == project_id,
                FinalDecision.stage == ScreeningStage.TITLE_ABSTRACT,
                FinalDecision.outcome == ScreeningOutcome.INCLUDE,
                FinalDecision.is_valid.is_(True),
            )
        )
    )
    excluded_ids = set(
        db.scalars(
            select(FinalDecision.publication_id).where(
                FinalDecision.project_id == project_id,
                FinalDecision.stage == ScreeningStage.FULL_TEXT,
                FinalDecision.outcome == ScreeningOutcome.EXCLUDE,
                FinalDecision.is_valid.is_(True),
            )
        )
    )
    eligible_ids -= excluded_ids
    document_ids = (
        set(
            db.scalars(
                select(PublicationDocument.publication_id).where(
                    PublicationDocument.project_id == project_id,
                    PublicationDocument.publication_id.in_(eligible_ids),
                    PublicationDocument.is_active.is_(True),
                )
            )
        )
        if eligible_ids
        else set()
    )
    outdated_count = (
        int(
            db.scalar(
                select(func.count())
                .select_from(LlmExtractionRun)
                .where(
                    LlmExtractionRun.project_id == project_id,
                    LlmExtractionRun.task_type == LlmTaskType.DATA_EXTRACTION,
                    LlmExtractionRun.schema_version_id != current.id,
                )
            )
            or 0
        )
        if current
        else 0
    )

    def average(name: str) -> float | None:
        values = [
            getattr(run, name) for run in completed if getattr(run, name) is not None
        ]
        return sum(values) / len(values) if values else None

    return {
        "total": total,
        "counts": dict(counts),
        "overview": {
            "eligible": len(eligible_ids),
            "missingPdf": len(eligible_ids - document_ids),
            "outdatedSchema": outdated_count,
        },
        "statistics": {
            "averageDuration": average("total_duration"),
            "averagePromptTokens": average("prompt_eval_count"),
            "averageGeneratedTokens": average("eval_count"),
        },
        "runs": [
            {
                "id": run.id,
                "publicationId": run.publication_id,
                "documentId": run.document_id,
                "schemaVersionId": run.schema_version_id,
                "taskType": run.task_type,
                "model": run.model,
                "status": run.status,
                "outdated": bool(
                    current
                    and run.task_type == LlmTaskType.DATA_EXTRACTION
                    and run.schema_version_id != current.id
                ),
                "queuedAt": run.queued_at,
                "completedAt": run.completed_at,
                "error": run.error_message,
                "totalDuration": run.total_duration,
                "promptEvalCount": run.prompt_eval_count,
                "evalCount": run.eval_count,
            }
            for run in runs
        ],
    }
