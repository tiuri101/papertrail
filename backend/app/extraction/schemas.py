from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from app.forms.schemas import FieldResponse
from app.screening.schemas import PublicationItem


class ApiModel(BaseModel):
    model_config = ConfigDict(from_attributes=True, populate_by_name=True)


class ExtractionSubmit(ApiModel):
    answers: dict
    suggestion_actions: dict[
        str, Literal["accepted", "modified", "ignored", "manual"]
    ] = Field(default_factory=dict, alias="suggestionActions")


class ExtractionDraftUpdate(ApiModel):
    draft: dict


class ExtractionItemResponse(ApiModel):
    id: str
    publication_id: str = Field(serialization_alias="publicationId")
    full_text_available: bool = Field(serialization_alias="fullTextAvailable")
    assigned_reviewer_id: str = Field(serialization_alias="assignedReviewerId")
    status: str
    draft: dict
    publication: PublicationItem
    fields: list[FieldResponse]


class ExtractionResponseModel(ApiModel):
    id: str
    answers: dict
    version: int
    form_version_id: str = Field(serialization_alias="formVersionId")
