from __future__ import annotations

from collections import Counter
from typing import Any
from urllib.parse import urlsplit, urlunsplit

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
from app.extraction.models import ExtractionWorkItem
from app.forms.schemas import FieldResponse
from app.fulltext.documents import active_document
from app.fulltext.models import PublicationDocument
from app.llm.models import (
    DocumentTextExtraction,
    LlmExtractionRun,
    LlmSchemaVersion,
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
    LlmSchemaUpdate,
    LlmSettingsUpdate,
    ManualRunRequest,
    ReanalysisRequest,
)
from app.llm.service import (
    latest_current_run,
    queue_llm_run_after_text,
    queue_preparation_if_eligible,
)
from app.projects.dependencies import (
    require_project_manager,
    require_project_manager_csrf,
)
from app.projects.models import ProjectMembership, ScreeningStage
from app.projects.service import is_project_manager, require_project_access
from app.publications.models import Publication
from app.screening.models import ScreeningOutcome

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
        "installationEnabled": config.llm_enabled,
        "provider": "Ollama",
        "endpoint": _public_endpoint(config.ollama_base_url),
        "model": config.ollama_model,
        "contextLength": config.llm_context_length,
        "currentSchemaVersionId": settings.current_schema_version_id
        if settings
        else None,
    }


@router.patch("/projects/{project_id}/llm/settings")
def update_llm_settings(
    project_id: str,
    payload: LlmSettingsUpdate,
    manager: User = Depends(require_project_manager_csrf),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    if payload.enabled and not get_settings().llm_enabled:
        raise DomainError("LLM support is disabled for this Papertrail installation")
    settings = project_settings(db, project_id, create=True)
    assert settings is not None
    settings.enabled = payload.enabled
    settings.updated_by_user_id = manager.id
    record_audit(
        db,
        action="llm.assistance_enabled"
        if payload.enabled
        else "llm.assistance_disabled",
        entity_type="project_llm_settings",
        entity_id=settings.id,
        project_id=project_id,
        actor_id=manager.id,
        summary=f"{'Enabled' if payload.enabled else 'Disabled'} LLM-assisted extraction",
    )
    if payload.enabled and current_schema(db, project_id):
        eligible_ids = list(
            db.scalars(
                select(FinalDecision.publication_id).where(
                    FinalDecision.project_id == project_id,
                    FinalDecision.stage == ScreeningStage.TITLE_ABSTRACT,
                    FinalDecision.outcome == ScreeningOutcome.INCLUDE,
                    FinalDecision.is_valid.is_(True),
                )
            )
        )
        for publication_id in eligible_ids:
            queue_preparation_if_eligible(
                db, publication_id, created_by_id=manager.id, priority=-10
            )
    db.commit()
    return {"enabled": settings.enabled}


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
    if payload.scope not in {"eligible", "full_text_included"}:
        raise DomainError("Unsupported re-analysis scope")
    stage = (
        ScreeningStage.FULL_TEXT
        if payload.scope == "full_text_included"
        else ScreeningStage.TITLE_ABSTRACT
    )
    publication_ids = list(
        db.scalars(
            select(FinalDecision.publication_id).where(
                FinalDecision.project_id == project_id,
                FinalDecision.stage == stage,
                FinalDecision.outcome == ScreeningOutcome.INCLUDE,
                FinalDecision.is_valid.is_(True),
            )
        )
    )
    queued = 0
    for publication_id in publication_ids:
        result = queue_preparation_if_eligible(
            db, publication_id, created_by_id=manager.id, priority=-10
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
                )
        if result is not None:
            queued += 1
    record_audit(
        db,
        action="llm.extraction_reanalysis_queued",
        entity_type="project",
        entity_id=project_id,
        project_id=project_id,
        actor_id=manager.id,
        summary="Queued project LLM re-analysis",
        metadata={"scope": payload.scope, "count": queued},
    )
    db.commit()
    return {"scope": payload.scope, "queued": queued}


def _assistance_payload(
    db: Session, project_id: str, publication_id: str
) -> dict[str, Any]:
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
        "outdated": bool(schema and run.schema_version_id != schema.id),
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
                "model": run.model,
                "status": run.status,
                "outdated": bool(current and run.schema_version_id != current.id),
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
