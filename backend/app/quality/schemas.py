from datetime import datetime
from typing import Any

from pydantic import Field

from app.api.schemas import ApiModel
from app.forms.schemas import FieldResponse
from app.projects.models import TaskAllocationMode
from app.quality.models import QualityAggregation, QualityMode
from app.screening.schemas import PublicationItem


class QualityConfigUpdate(ApiModel):
    """Typed rather than free-text on purpose: an unrecognized ``mode`` or
    ``aggregation`` used to be stored verbatim and then silently reinterpreted
    downstream (any unknown aggregation scored as a plain sum). Pydantic now
    rejects it with a 422 before it reaches the database."""

    enabled: bool
    mode: QualityMode = QualityMode.BOTH
    aggregation: QualityAggregation = QualityAggregation.SUM
    allocation_mode: TaskAllocationMode = Field(
        default=TaskAllocationMode.CLAIM, alias="allocationMode"
    )


class QualityConfigResponse(ApiModel):
    enabled: bool
    mode: QualityMode
    aggregation: QualityAggregation
    allocation_mode: TaskAllocationMode = Field(serialization_alias="allocationMode")


class QualitySubmit(ApiModel):
    answers: dict[str, Any]


class QualityDraftUpdate(ApiModel):
    draft: dict[str, Any]


class QualityResponseModel(ApiModel):
    id: str
    answers: dict[str, Any]
    total_score: float | None = Field(serialization_alias="totalScore")
    version: int


class QualityItemResponse(ApiModel):
    id: str
    publication_id: str = Field(serialization_alias="publicationId")
    status: str
    draft: dict[str, Any]
    publication: PublicationItem
    fields: list[FieldResponse]
    current_response: QualityResponseModel | None = Field(
        default=None, serialization_alias="currentResponse"
    )


class CompletedQualitySummary(ApiModel):
    id: str
    publication_id: str = Field(serialization_alias="publicationId")
    publication: PublicationItem
    completed_at: datetime | None = Field(serialization_alias="completedAt")
    version: int
    total_score: float | None = Field(serialization_alias="totalScore")
