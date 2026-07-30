from pydantic import BaseModel, ConfigDict, Field


class ApiModel(BaseModel):
    model_config = ConfigDict(
        populate_by_name=True, from_attributes=True, use_enum_values=True
    )


class FinalDecisionCreate(ApiModel):
    outcome: str
    resolution_method: str = Field(alias="resolutionMethod")
    note: str | None = None


class FinalDecisionResponse(ApiModel):
    id: str
    publication_id: str = Field(serialization_alias="publicationId")
    stage: str
    outcome: str
    resolution_method: str = Field(serialization_alias="resolutionMethod")
    resolved_by_id: str | None = Field(serialization_alias="resolvedById")
    note: str | None
    is_valid: bool = Field(serialization_alias="isValid")


class ConflictPublication(ApiModel):
    id: str
    title: str
    authors: str | None
    abstract: str | None
    doi: str | None
    publisher_url: str | None = Field(serialization_alias="publisherUrl")


class ConflictReviewer(ApiModel):
    id: str
    display_name: str = Field(serialization_alias="displayName")


class ConflictDecision(ApiModel):
    reviewer: ConflictReviewer
    outcome: str
    exclusion_reason_text: str | None = Field(serialization_alias="exclusionReasonText")
    notes: str | None


class ConflictItem(ApiModel):
    publication_id: str = Field(serialization_alias="publicationId")
    publication: ConflictPublication
    decisions: list[ConflictDecision]
