from pydantic import BaseModel, ConfigDict, Field

from app.forms.schemas import FieldResponse
from app.screening.schemas import PublicationItem


class ApiModel(BaseModel):
    model_config = ConfigDict(from_attributes=True, populate_by_name=True)


class QualityConfigUpdate(ApiModel):
    enabled: bool
    mode: str = "both"
    aggregation: str = "sum"


class QualityConfigResponse(ApiModel):
    enabled: bool
    mode: str
    aggregation: str


class QualitySubmit(ApiModel):
    answers: dict


class QualityItemResponse(ApiModel):
    id: str
    publication_id: str = Field(serialization_alias="publicationId")
    status: str
    draft: dict
    publication: PublicationItem
    fields: list[FieldResponse]


class QualityResponseModel(ApiModel):
    id: str
    answers: dict
    total_score: float | None = Field(serialization_alias="totalScore")
    version: int
