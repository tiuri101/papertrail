from __future__ import annotations

from typing import Any

from pydantic import Field

from app.api.schemas import EnumApiModel as ApiModel


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
    draft: dict[str, Any]
    publication: PublicationItem
    criteria: list[CriterionItem]
    llm_assistance_enabled: bool = Field(serialization_alias="llmAssistanceEnabled")


class DraftUpdate(ApiModel):
    draft: dict[str, Any]


class DecisionSubmit(ApiModel):
    outcome: str
    criteria_answers: dict[str, bool] = Field(alias="criteriaAnswers")
    notes: str | None = None


class DecisionOverride(DecisionSubmit):
    reason: str = Field(min_length=1, max_length=2000)


class DecisionResponse(ApiModel):
    id: str
    reviewer_id: str = Field(serialization_alias="reviewerId")
    outcome: str
    criteria_answers: dict[str, bool] = Field(serialization_alias="criteriaAnswers")
    notes: str | None
    version: int


class WorkItemDetailResponse(WorkItemResponse):
    decision: DecisionResponse | None = None


class DecisionSubmitResponse(DecisionResponse):
    project_stage: str | None = Field(default=None, serialization_alias="projectStage")
    stage_unchanged: bool = Field(default=False, serialization_alias="stageUnchanged")
    pending_workflow_steps: list[str] = Field(
        default_factory=list, serialization_alias="pendingWorkflowSteps"
    )


class MyDecisionItem(ApiModel):
    work_item_id: str = Field(serialization_alias="workItemId")
    submitted_at: str | None = Field(serialization_alias="submittedAt")
    publication: PublicationItem
    decision: DecisionResponse | None = None
    retrieval_status: str | None = Field(
        default=None, serialization_alias="retrievalStatus"
    )
    retrieval_note: str | None = Field(
        default=None, serialization_alias="retrievalNote"
    )


class MyDecisionsResponse(ApiModel):
    stage_completed: bool = Field(serialization_alias="stageCompleted")
    criteria: list[CriterionItem]
    items: list[MyDecisionItem]


class MyProgressResponse(ApiModel):
    assigned: int
    completed: int
    remaining: int
    claim_mode: bool = Field(serialization_alias="claimMode")


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


class BulkReassignRequest(ApiModel):
    reviewer_id: str = Field(alias="reviewerId")
    work_item_ids: list[str] = Field(default_factory=list, alias="workItemIds")
    select_all_filtered: bool = Field(default=False, alias="selectAllFiltered")
    excluded_work_item_ids: list[str] = Field(
        default_factory=list, alias="excludedWorkItemIds"
    )
    search: str | None = None
    status: str | None = None
    filter_reviewer_id: str | None = Field(default=None, alias="filterReviewerId")


class BulkReassignResponse(ApiModel):
    reassigned: int


class AssignmentsPage(ApiModel):
    items: list[AssignmentItem]
    total: int
    reassignable_total: int = Field(serialization_alias="reassignableTotal")
    page: int
    page_size: int = Field(serialization_alias="pageSize")
