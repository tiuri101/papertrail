from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator


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
    analysis_narrative_enabled: bool | None = Field(
        default=None, alias="analysisNarrativeEnabled"
    )


class LlmInstallationSettingsUpdate(ApiModel):
    enabled: bool
    endpoint: str
    model: str
    context_length: int = Field(alias="contextLength", ge=4096)
    api_key: str | None = Field(default=None, alias="apiKey")
    request_timeout_seconds: int = Field(
        alias="requestTimeoutSeconds", ge=1
    )
    max_concurrent_jobs: int = Field(alias="maxConcurrentJobs", ge=1)
    max_evidence_items: int = Field(alias="maxEvidenceItems", ge=1, le=10)
    max_evidence_quote_chars: int = Field(
        alias="maxEvidenceQuoteChars", ge=50, le=2000
    )

    @field_validator("api_key")
    @classmethod
    def validate_api_key(cls, value: str | None) -> str | None:
        if value is None or not value.strip():
            return None
        return value.strip()

    @field_validator("endpoint")
    @classmethod
    def validate_endpoint(cls, value: str) -> str:
        from urllib.parse import urlsplit

        normalized = value.strip().rstrip("/")
        parsed = urlsplit(normalized)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise ValueError("Endpoint must be a valid HTTP(S) server URL")
        return normalized

    @field_validator("model")
    @classmethod
    def validate_model(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("Model is required")
        return normalized


class LlmPromptFlowStatus(ApiModel):
    key: str
    label: str
    default_prompt: str = Field(serialization_alias="defaultPrompt")
    current_prompt: str = Field(serialization_alias="currentPrompt")
    is_overridden: bool = Field(serialization_alias="isOverridden")


class LlmPromptOverridesResponse(ApiModel):
    flows: list[LlmPromptFlowStatus]


class LlmPromptOverridesUpdate(ApiModel):
    title_abstract_prompt: str | None = Field(default=None, alias="titleAbstractPrompt")
    full_text_prompt: str | None = Field(default=None, alias="fullTextPrompt")
    extraction_prompt: str | None = Field(default=None, alias="extractionPrompt")
    validation_prompt: str | None = Field(default=None, alias="validationPrompt")


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
    task_type: str = Field(alias="taskType")


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


class ValidationReviewPublication(ApiModel):
    id: str
    title: str
    authors: str | None = None
    publication_year: int | None = Field(default=None, alias="publicationYear")


class ValidationReviewItem(ApiModel):
    work_item_id: str = Field(alias="workItemId")
    publication_id: str = Field(alias="publicationId")
    assigned_reviewer_id: str | None = Field(alias="assignedReviewerId")
    response_id: str | None = Field(default=None, alias="responseId")
    full_text_available: bool = Field(alias="fullTextAvailable")
    state: str
    run_id: str | None = Field(default=None, alias="runId")
    model: str | None = None
    prompt_version: str | None = Field(default=None, alias="promptVersion")
    error: str | None = None
    publication: ValidationReviewPublication
    results: list[ValidationResultResponse] = Field(default_factory=list)


class ValidationProgressResponse(ApiModel):
    total: int
    completed: int
    pending: int
    failed: int
    unavailable: int
    outstanding: int
    settled: bool


class ValidationReviewResponse(ApiModel):
    enabled: bool
    progress: ValidationProgressResponse
    items: list[ValidationReviewItem] = Field(default_factory=list)
