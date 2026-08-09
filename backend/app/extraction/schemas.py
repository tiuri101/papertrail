from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from app.forms.schemas import FieldResponse
from app.screening.schemas import PublicationItem


class ApiModel(BaseModel):
    model_config = ConfigDict(from_attributes=True, populate_by_name=True)


class ExtractionSubmit(ApiModel):
    answers: dict[str, Any]
    suggestion_actions: dict[
        str, Literal["accepted", "modified", "ignored", "manual"]
    ] = Field(default_factory=dict, alias="suggestionActions")


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
    full_text_available: bool = Field(serialization_alias="fullTextAvailable")
    assigned_reviewer_id: str = Field(serialization_alias="assignedReviewerId")
    status: str
    draft: dict[str, Any]
    publication: PublicationItem
    fields: list[FieldResponse]
    current_response: ExtractionResponseModel | None = Field(
        default=None, serialization_alias="currentResponse"
    )
