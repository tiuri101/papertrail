from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field


class ApiModel(BaseModel):
    model_config = ConfigDict(
        populate_by_name=True, from_attributes=True, use_enum_values=True
    )


class CriterionItem(ApiModel):
    id: str
    kind: str
    text: str


class PublicationItem(ApiModel):
    id: str
    title: str
    authors: str | None
    abstract: str | None
    publication_year: int | None = Field(serialization_alias="publicationYear")
    venue: str | None
    publication_type: str | None = Field(serialization_alias="publicationType")
    doi: str | None
    publisher_url: str | None = Field(serialization_alias="publisherUrl")
    keywords: str | None


class WorkItemResponse(ApiModel):
    id: str
    project_id: str = Field(serialization_alias="projectId")
    stage: str
    slot_number: int = Field(serialization_alias="slotNumber")
    reserved_until: str | None = Field(serialization_alias="reservedUntil")
    draft: dict
    publication: PublicationItem
    criteria: list[CriterionItem]


class DraftUpdate(ApiModel):
    draft: dict


class DecisionSubmit(ApiModel):
    outcome: str
    criteria_answers: dict[str, bool] = Field(alias="criteriaAnswers")
    notes: str | None = None


class DecisionResponse(ApiModel):
    id: str
    reviewer_id: str = Field(serialization_alias="reviewerId")
    outcome: str
    criteria_answers: dict[str, bool] = Field(serialization_alias="criteriaAnswers")
    notes: str | None
    version: int
