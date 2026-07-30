from pydantic import BaseModel, ConfigDict, Field


class ApiModel(BaseModel):
    model_config = ConfigDict(populate_by_name=True, from_attributes=True, use_enum_values=True)


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
