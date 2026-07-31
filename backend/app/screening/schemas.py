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


class MyDecisionItem(ApiModel):
    work_item_id: str = Field(serialization_alias="workItemId")
    submitted_at: str | None = Field(serialization_alias="submittedAt")
    publication: PublicationItem
    decision: DecisionResponse


class MyDecisionsResponse(ApiModel):
    stage_completed: bool = Field(serialization_alias="stageCompleted")
    criteria: list[CriterionItem]
    items: list[MyDecisionItem]


class MyProgressResponse(ApiModel):
    assigned: int
    completed: int


class AssignmentItem(ApiModel):
    id: str
    publication_id: str = Field(serialization_alias="publicationId")
    publication_title: str = Field(serialization_alias="publicationTitle")
    slot_number: int = Field(serialization_alias="slotNumber")
    status: str
    assigned_reviewer_id: str | None = Field(serialization_alias="assignedReviewerId")
    assigned_reviewer_name: str | None = Field(
        serialization_alias="assignedReviewerName"
    )


class ReassignRequest(ApiModel):
    reviewer_id: str = Field(alias="reviewerId")


class AssignmentsPage(ApiModel):
    items: list[AssignmentItem]
    total: int
    page: int
    page_size: int = Field(serialization_alias="pageSize")
