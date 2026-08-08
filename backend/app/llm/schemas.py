from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class ApiModel(BaseModel):
    model_config = ConfigDict(
        from_attributes=True, populate_by_name=True, use_enum_values=True
    )


class LlmSettingsUpdate(ApiModel):
    enabled: bool | None = None
    title_abstract_screening_enabled: bool | None = Field(
        default=None, alias="titleAbstractScreeningEnabled"
    )
    full_text_screening_enabled: bool | None = Field(
        default=None, alias="fullTextScreeningEnabled"
    )
    extraction_validation_enabled: bool | None = Field(
        default=None, alias="extractionValidationEnabled"
    )


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
    section: str | None = None
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


class CriterionSuggestionResponse(ApiModel):
    criterion_id: str | None = Field(default=None, alias="criterionId")
    criterion_text: str = Field(alias="criterionText")
    criterion_kind: str = Field(alias="criterionKind")
    assessment: str
    explanation: str
    evidence: list[EvidenceResponse] = Field(default_factory=list)
    evidence_validation_status: str = Field(alias="evidenceValidationStatus")


class ScreeningAssistanceResponse(ApiModel):
    state: str
    hidden: bool = False
    run_id: str | None = Field(default=None, alias="runId")
    document_id: str | None = Field(default=None, alias="documentId")
    model: str | None = None
    prompt_version: str | None = Field(default=None, alias="promptVersion")
    stale: bool = False
    error: str | None = None
    suggested_decision: str | None = Field(default=None, alias="suggestedDecision")
    confidence: str | None = None
    reasoning_summary: str | None = Field(default=None, alias="reasoningSummary")
    criteria: list[CriterionSuggestionResponse] = Field(default_factory=list)


class ValidationResultResponse(ApiModel):
    field_key: str = Field(alias="fieldKey")
    field_label: str = Field(alias="fieldLabel")
    value: Any | None
    assessment: str
    explanation: str
    evidence: list[EvidenceResponse] = Field(default_factory=list)
    evidence_validation_status: str = Field(alias="evidenceValidationStatus")


class ExtractionValidationResponse(ApiModel):
    state: str
    run_id: str | None = Field(default=None, alias="runId")
    response_id: str | None = Field(default=None, alias="responseId")
    model: str | None = None
    prompt_version: str | None = Field(default=None, alias="promptVersion")
    stale: bool = False
    error: str | None = None
    results: list[ValidationResultResponse] = Field(default_factory=list)
