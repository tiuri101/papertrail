from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class ApiModel(BaseModel):
    model_config = ConfigDict(
        from_attributes=True, populate_by_name=True, use_enum_values=True
    )


class LlmSettingsUpdate(ApiModel):
    enabled: bool


class LlmFieldUpdate(ApiModel):
    stable_key: str | None = Field(default=None, alias="stableKey")
    label: str = Field(min_length=1, max_length=300)
    instruction: str = Field(min_length=1)
    field_type: str = Field(alias="fieldType")
    mapped_extraction_field_key: str | None = Field(
        default=None, alias="mappedExtractionFieldKey"
    )
    options: list[str] = Field(default_factory=list)
    evidence_required: bool = Field(default=True, alias="evidenceRequired")
    allow_inferred: bool = Field(default=False, alias="allowInferred")
    enabled: bool = True


class LlmSchemaUpdate(ApiModel):
    fields: list[LlmFieldUpdate]


class ManualRunRequest(ApiModel):
    force: bool = False


class ReanalysisRequest(ApiModel):
    scope: str = "eligible"


class EvidenceResponse(ApiModel):
    page: int
    quote: str
    verified: bool


class SuggestionResponse(ApiModel):
    id: str
    schema_field_id: str = Field(alias="schemaFieldId")
    mapped_extraction_field_key: str | None = Field(alias="mappedExtractionFieldKey")
    label: str
    value: Any | None
    status: str
    evidence: list[EvidenceResponse]
    evidence_validation_status: str = Field(alias="evidenceValidationStatus")
    evidence_required: bool = Field(alias="evidenceRequired")
    helper: bool


class AssistanceResponse(ApiModel):
    state: str
    run_id: str | None = Field(default=None, alias="runId")
    document_id: str | None = Field(default=None, alias="documentId")
    schema_version: int | None = Field(default=None, alias="schemaVersion")
    model: str | None = None
    outdated: bool = False
    error: str | None = None
    suggestions: list[SuggestionResponse] = Field(default_factory=list)
