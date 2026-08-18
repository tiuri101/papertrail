from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from app.forms.schemas import FieldResponse
from app.projects.models import TaskAllocationMode
from app.screening.schemas import PublicationItem


class ApiModel(BaseModel):
    model_config = ConfigDict(from_attributes=True, populate_by_name=True)


class ExtractionConfigUpdate(ApiModel):
    allocation_mode: TaskAllocationMode = Field(alias="allocationMode")
    required_reviewers: int = Field(alias="requiredReviewers", ge=1, le=2)


class ExtractionConfigResponse(ApiModel):
    allocation_mode: TaskAllocationMode = Field(serialization_alias="allocationMode")
    required_reviewers: int = Field(serialization_alias="requiredReviewers")


class ExtractionSubmit(ApiModel):
    answers: dict[str, Any]
    suggestion_actions: dict[
        str, Literal["accepted", "modified", "ignored", "manual"]
    ] = Field(default_factory=dict, alias="suggestionActions")


class ExtractionOverride(ApiModel):
    answers: dict[str, Any]
    reason: str = Field(min_length=1, max_length=2000)


class ExtractionDraftUpdate(ApiModel):
    draft: dict[str, Any]


class ExtractionResponseModel(ApiModel):
    id: str
    answers: dict[str, Any]
    version: int
    form_version_id: str = Field(serialization_alias="formVersionId")


class ExtractionItemResponse(ApiModel):
    id: str
    publication_id: str = Field(serialization_alias="publicationId")
    slot_number: int = Field(serialization_alias="slotNumber")
    required_reviewers: int = Field(serialization_alias="requiredReviewers")
    full_text_available: bool = Field(serialization_alias="fullTextAvailable")
    assigned_reviewer_id: str | None = Field(serialization_alias="assignedReviewerId")
    status: str
    draft: dict[str, Any]
    publication: PublicationItem
    fields: list[FieldResponse]
    current_response: ExtractionResponseModel | None = Field(
        default=None, serialization_alias="currentResponse"
    )


class CompletedExtractionSummary(ApiModel):
    id: str
    publication_id: str = Field(serialization_alias="publicationId")
    slot_number: int = Field(serialization_alias="slotNumber")
    publication: PublicationItem
    completed_at: datetime | None = Field(serialization_alias="completedAt")
    version: int


class FieldProvenanceEntry(ApiModel):
    from_: Literal["response_a", "response_b", "agreed", "manual"] = Field(
        alias="from"
    )
    response_id: str | None = Field(alias="responseId")


class FinalExtractionModel(ApiModel):
    id: str
    publication_id: str = Field(serialization_alias="publicationId")
    answers: dict[str, Any]
    form_version_id: str = Field(serialization_alias="formVersionId")
    resolution_method: str = Field(serialization_alias="resolutionMethod")
    resolved_by_id: str | None = Field(serialization_alias="resolvedById")
    note: str | None
    field_provenance: dict[str, FieldProvenanceEntry] = Field(
        serialization_alias="fieldProvenance"
    )
    contributing_response_ids: list[str] = Field(
        serialization_alias="contributingResponseIds"
    )
    created_at: datetime = Field(serialization_alias="createdAt")


class ReconciliationQueueItem(ApiModel):
    publication: PublicationItem


class ReconciliationFieldComparison(ApiModel):
    stable_key: str = Field(serialization_alias="stableKey")
    field_type: str = Field(serialization_alias="fieldType")
    value_a: Any = Field(serialization_alias="valueA")
    value_b: Any = Field(serialization_alias="valueB")
    agree: bool


class ReconciliationDetailResponse(ApiModel):
    publication: PublicationItem
    full_text_available: bool = Field(serialization_alias="fullTextAvailable")
    fields: list[FieldResponse]
    comparisons: list[ReconciliationFieldComparison]


class ReconciliationFieldChoice(ApiModel):
    choice: Literal["response_a", "response_b", "manual"]
    value: Any = None


class ReconciliationSubmit(ApiModel):
    field_choices: dict[str, ReconciliationFieldChoice] = Field(
        alias="fieldChoices", default_factory=dict
    )
    note: str = Field(min_length=1, max_length=2000)
