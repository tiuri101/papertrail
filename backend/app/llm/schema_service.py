from __future__ import annotations

from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from app.api.errors import ConflictError, DomainError
from app.audit.service import record_audit
from app.forms.models import FieldType, FormField, FormKind, ReviewForm
from app.forms.service import active_fields as forms_active_fields
from app.forms.service import project_form_by_kind
from app.llm.models import (
    LlmSchemaField,
    LlmSchemaVersion,
    ProjectLlmSettings,
    SchemaStatus,
)

SUPPORTED_FIELD_TYPES = {item.value for item in FieldType}


def project_settings(
    db: Session, project_id: str, *, create: bool = False
) -> ProjectLlmSettings | None:
    result = db.scalar(
        select(ProjectLlmSettings).where(ProjectLlmSettings.project_id == project_id)
    )
    if result is None and create:
        result = ProjectLlmSettings(project_id=project_id, enabled=False)
        db.add(result)
        db.flush()
    return result


def extraction_form(db: Session, project_id: str) -> ReviewForm | None:
    return project_form_by_kind(db, project_id, FormKind.EXTRACTION)


def active_extraction_fields(db: Session, project_id: str) -> list[FormField]:
    form = extraction_form(db, project_id)
    if form is None or not form.active_version_id:
        return []
    return forms_active_fields(db, form)


def latest_schema(db: Session, project_id: str) -> LlmSchemaVersion | None:
    return db.scalar(
        select(LlmSchemaVersion)
        .options(selectinload(LlmSchemaVersion.fields))
        .where(LlmSchemaVersion.project_id == project_id)
        .order_by(LlmSchemaVersion.version_number.desc())
    )


def current_schema(db: Session, project_id: str) -> LlmSchemaVersion | None:
    settings = project_settings(db, project_id)
    if settings is None or settings.current_schema_version_id is None:
        return None
    return db.scalar(
        select(LlmSchemaVersion)
        .options(selectinload(LlmSchemaVersion.fields))
        .where(
            LlmSchemaVersion.id == settings.current_schema_version_id,
            LlmSchemaVersion.project_id == project_id,
        )
    )


def _next_version(db: Session, project_id: str) -> int:
    return (
        int(
            db.scalar(
                select(
                    func.coalesce(func.max(LlmSchemaVersion.version_number), 0)
                ).where(LlmSchemaVersion.project_id == project_id)
            )
            or 0
        )
        + 1
    )


def initialize_from_form(
    db: Session, project_id: str, user_id: str
) -> LlmSchemaVersion:
    fields = active_extraction_fields(db, project_id)
    form = extraction_form(db, project_id)
    if form is None or not form.active_version_id:
        raise DomainError("Configure an extraction form before creating the LLM schema")
    existing = latest_schema(db, project_id)
    if existing is not None and existing.status == SchemaStatus.DRAFT:
        raise ConflictError("An editable LLM schema draft already exists")
    schema = LlmSchemaVersion(
        project_id=project_id,
        version_number=_next_version(db, project_id),
        status=SchemaStatus.DRAFT,
        based_on_form_version_id=form.active_version_id,
        created_by_user_id=user_id,
    )
    db.add(schema)
    db.flush()
    for position, field in enumerate(fields):
        db.add(
            LlmSchemaField(
                schema_version_id=schema.id,
                stable_key=field.stable_key,
                label=field.label,
                instruction=(
                    f"Extract {field.label}. Use not_found when the paper does not explicitly "
                    "provide enough information."
                ),
                field_type=field.field_type.value,
                mapped_extraction_field_key=field.stable_key,
                options=list(field.options),
                evidence_required=True,
                allow_inferred=False,
                enabled=True,
                position=position,
            )
        )
    record_audit(
        db,
        action="llm.schema_created",
        entity_type="llm_schema_version",
        entity_id=schema.id,
        project_id=project_id,
        actor_id=user_id,
        summary="Created LLM extraction schema from extraction form",
        metadata={"version": schema.version_number},
    )
    db.flush()
    db.refresh(schema)
    return schema


def fork_published_schema(
    db: Session, schema: LlmSchemaVersion, user_id: str
) -> LlmSchemaVersion:
    if schema.status == SchemaStatus.DRAFT:
        return schema
    draft = LlmSchemaVersion(
        project_id=schema.project_id,
        version_number=_next_version(db, schema.project_id),
        status=SchemaStatus.DRAFT,
        based_on_form_version_id=schema.based_on_form_version_id,
        created_by_user_id=user_id,
    )
    db.add(draft)
    db.flush()
    for field in sorted(schema.fields, key=lambda item: item.position):
        db.add(
            LlmSchemaField(
                schema_version_id=draft.id,
                stable_key=field.stable_key,
                label=field.label,
                instruction=field.instruction,
                field_type=field.field_type,
                mapped_extraction_field_key=field.mapped_extraction_field_key,
                options=list(field.options),
                evidence_required=field.evidence_required,
                allow_inferred=field.allow_inferred,
                enabled=field.enabled,
                position=field.position,
            )
        )
    db.flush()
    db.refresh(draft)
    return draft


def mapping_state(db: Session, project_id: str, field: LlmSchemaField) -> str:
    key = field.mapped_extraction_field_key
    if key is None:
        return "helper"
    candidates = {
        item.stable_key: item for item in active_extraction_fields(db, project_id)
    }
    target = candidates.get(key)
    if target is None:
        return "outdated"
    return "active" if target.field_type.value == field.field_type else "incompatible"


def validate_field_mapping(
    db: Session,
    project_id: str,
    field_type: str,
    mapped_key: str | None,
    options: list[Any],
) -> None:
    if field_type not in SUPPORTED_FIELD_TYPES:
        raise DomainError("Unsupported LLM field type")
    if mapped_key is None:
        return
    target = next(
        (
            field
            for field in active_extraction_fields(db, project_id)
            if field.stable_key == mapped_key
        ),
        None,
    )
    if target is None:
        raise DomainError("Mapped extraction field is archived or does not exist")
    if target.field_type.value != field_type:
        raise DomainError("LLM field type is incompatible with the extraction field")
    if field_type in {
        FieldType.SINGLE_SELECT.value,
        FieldType.MULTIPLE_SELECT.value,
    } and list(options) != list(target.options):
        raise DomainError(
            "Mapped selection fields must use the extraction field options"
        )
    if field_type == FieldType.RATING.value and list(options) != list(target.options):
        raise DomainError("Mapped rating fields must use the extraction field range")


def update_schema_fields(
    db: Session,
    schema: LlmSchemaVersion,
    fields: list[dict[str, Any]],
    user_id: str,
) -> LlmSchemaVersion:
    schema = fork_published_schema(db, schema, user_id)
    if schema.status != SchemaStatus.DRAFT:
        raise ConflictError("Published schema versions are immutable")
    seen_keys: set[str] = set()
    existing = {field.stable_key: field for field in schema.fields}
    for position, item in enumerate(fields):
        stable_key = str(item.get("stable_key") or uuid4())
        if stable_key in seen_keys:
            raise DomainError("LLM schema field keys must be unique")
        seen_keys.add(stable_key)
        field_type = str(item["field_type"])
        mapped_key = item.get("mapped_extraction_field_key")
        options = list(item.get("options") or [])
        validate_field_mapping(db, schema.project_id, field_type, mapped_key, options)
        field = existing.get(stable_key)
        if field is None:
            field = LlmSchemaField(schema_version_id=schema.id, stable_key=stable_key)
            db.add(field)
        field.label = str(item["label"]).strip()
        field.instruction = str(item["instruction"]).strip()
        if not field.label or not field.instruction:
            raise DomainError(
                "Every LLM field needs a label and extraction instruction"
            )
        field.field_type = field_type
        field.mapped_extraction_field_key = mapped_key
        field.options = options
        field.evidence_required = bool(item.get("evidence_required", True))
        field.allow_inferred = bool(item.get("allow_inferred", False))
        field.enabled = bool(item.get("enabled", True))
        field.position = position
    for key, field in existing.items():
        if key not in seen_keys:
            db.delete(field)
    record_audit(
        db,
        action="llm.schema_mapping_changed",
        entity_type="llm_schema_version",
        entity_id=schema.id,
        project_id=schema.project_id,
        actor_id=user_id,
        summary="Updated LLM extraction schema",
    )
    db.flush()
    db.refresh(schema)
    return schema


def publish_schema(
    db: Session, schema: LlmSchemaVersion, user_id: str
) -> LlmSchemaVersion:
    if schema.status != SchemaStatus.DRAFT:
        raise ConflictError("Only a draft LLM schema can be published")
    if not any(field.enabled for field in schema.fields):
        raise DomainError("Enable at least one LLM schema field before publishing")
    invalid = [
        field.label
        for field in schema.fields
        if mapping_state(db, schema.project_id, field) in {"outdated", "incompatible"}
    ]
    if invalid:
        raise DomainError("Resolve outdated or incompatible mappings before publishing")
    settings = project_settings(db, schema.project_id, create=True)
    assert settings is not None
    previous = current_schema(db, schema.project_id)
    if previous is not None:
        previous.status = SchemaStatus.SUPERSEDED
    schema.status = SchemaStatus.PUBLISHED
    schema.published_at = datetime.now(UTC)
    settings.current_schema_version_id = schema.id
    settings.updated_by_user_id = user_id
    record_audit(
        db,
        action="llm.schema_published",
        entity_type="llm_schema_version",
        entity_id=schema.id,
        project_id=schema.project_id,
        actor_id=user_id,
        summary="Published LLM extraction schema",
        metadata={"version": schema.version_number},
    )
    db.flush()
    return schema
