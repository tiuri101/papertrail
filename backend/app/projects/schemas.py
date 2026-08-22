from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

from app.api.schemas import EnumApiModel as ApiModel
from app.projects.models import (
    AllocationMode,
    CriterionKind,
    ProjectStage,
    ResolutionMethod,
    ReviewType,
    ScreeningStage,
)


class ProjectCreate(ApiModel):
    name: str = Field(min_length=1, max_length=250)
    description: str | None = None
    review_type: ReviewType = Field(alias="reviewType")


class ProjectSummary(ApiModel):
    id: str
    name: str
    description: str | None
    review_type: ReviewType = Field(serialization_alias="reviewType")
    stage: ProjectStage


class ProjectOwnerSummary(ApiModel):
    id: str
    display_name: str = Field(serialization_alias="displayName")


class ProjectListItem(ProjectSummary):
    created_at: datetime = Field(serialization_alias="createdAt")
    updated_at: datetime = Field(serialization_alias="updatedAt")
    owner: ProjectOwnerSummary | None
    my_role: Literal["owner", "administrator", "reviewer"] = Field(
        serialization_alias="myRole"
    )
    open_task_count: int = Field(serialization_alias="openTaskCount", ge=0)
    primary_label: str = Field(serialization_alias="primaryLabel")
    primary_count: int = Field(serialization_alias="primaryCount", ge=0)
    secondary_label: str = Field(serialization_alias="secondaryLabel")
    secondary_count: int = Field(serialization_alias="secondaryCount", ge=0)
    reviewer_count: int = Field(serialization_alias="reviewerCount", ge=0)
    percent_complete: int = Field(serialization_alias="percentComplete", ge=0, le=100)


class MembershipCreate(ApiModel):
    user_id: str = Field(alias="userId")
    can_title_abstract_screen: bool = Field(
        default=False, alias="canTitleAbstractScreen"
    )
    can_full_text_screen: bool = Field(default=False, alias="canFullTextScreen")
    can_extract: bool = Field(default=False, alias="canExtract")
    can_assess_quality: bool = Field(default=False, alias="canAssessQuality")
    can_adjudicate: bool = Field(default=False, alias="canAdjudicate")
    workload_weight: float = Field(default=1.0, alias="workloadWeight", gt=0, le=100)


class MembershipUpdate(ApiModel):
    can_title_abstract_screen: bool = Field(
        default=False, alias="canTitleAbstractScreen"
    )
    can_full_text_screen: bool = Field(default=False, alias="canFullTextScreen")
    can_extract: bool = Field(default=False, alias="canExtract")
    can_assess_quality: bool = Field(default=False, alias="canAssessQuality")
    can_adjudicate: bool = Field(default=False, alias="canAdjudicate")
    workload_weight: float = Field(default=1.0, alias="workloadWeight", gt=0, le=100)


class MembershipResponse(ApiModel):
    id: str
    user_id: str = Field(serialization_alias="userId")
    is_owner: bool = Field(serialization_alias="isOwner")
    can_title_abstract_screen: bool = Field(
        serialization_alias="canTitleAbstractScreen"
    )
    can_full_text_screen: bool = Field(serialization_alias="canFullTextScreen")
    can_extract: bool = Field(serialization_alias="canExtract")
    can_assess_quality: bool = Field(serialization_alias="canAssessQuality")
    can_adjudicate: bool = Field(serialization_alias="canAdjudicate")
    workload_weight: float = Field(serialization_alias="workloadWeight")


class OrderedTextCreate(ApiModel):
    text: str = Field(min_length=1)
    position: int | None = Field(default=None, ge=0)


class ResearchQuestionResponse(ApiModel):
    id: str
    text: str
    position: int


class ResearchQuestionUpdate(ApiModel):
    text: str = Field(min_length=1)


class CriterionCreate(OrderedTextCreate):
    kind: CriterionKind


class CriterionResponse(ApiModel):
    id: str
    kind: CriterionKind
    text: str
    position: int


class CriterionUpdate(ApiModel):
    kind: CriterionKind | None = None
    text: str = Field(min_length=1)


class ScreeningConfigUpdate(ApiModel):
    required_reviewers: int = Field(alias="requiredReviewers", ge=1, le=10)
    allocation_mode: AllocationMode = Field(alias="allocationMode")
    conflict_resolution: ResolutionMethod = Field(alias="conflictResolution")
    uncertain_resolution: ResolutionMethod = Field(alias="uncertainResolution")


class ScreeningConfigResponse(ApiModel):
    id: str
    stage: ScreeningStage
    required_reviewers: int = Field(serialization_alias="requiredReviewers")
    allocation_mode: AllocationMode = Field(serialization_alias="allocationMode")
    conflict_resolution: ResolutionMethod = Field(
        serialization_alias="conflictResolution"
    )
    uncertain_resolution: ResolutionMethod = Field(
        serialization_alias="uncertainResolution"
    )


class ProjectDetail(ProjectSummary):
    memberships: list[MembershipResponse]
    research_questions: list[ResearchQuestionResponse] = Field(
        serialization_alias="researchQuestions"
    )
    criteria: list[CriterionResponse]
    screening_configs: list[ScreeningConfigResponse] = Field(
        serialization_alias="screeningConfigs"
    )
    can_manage: bool = Field(serialization_alias="canManage")
    can_manage_publications: bool = Field(
        default=True, serialization_alias="canManagePublications"
    )
    extraction_validation_enabled: bool = Field(
        default=False, serialization_alias="extractionValidationEnabled"
    )
    can_title_abstract_screen: bool = Field(
        serialization_alias="canTitleAbstractScreen"
    )
    can_full_text_screen: bool = Field(serialization_alias="canFullTextScreen")
    can_extract: bool = Field(serialization_alias="canExtract")
    can_assess_quality: bool = Field(serialization_alias="canAssessQuality")
    can_adjudicate: bool = Field(serialization_alias="canAdjudicate")


class PromptFlowSettings(ApiModel):
    key: str
    label: str
    base_prompt: str = Field(serialization_alias="basePrompt")
    custom_instructions: str = Field(serialization_alias="customInstructions")


class PromptSettingsResponse(ApiModel):
    flows: list[PromptFlowSettings]


class PromptSettingsUpdate(ApiModel):
    extraction_instructions: str = Field(default="", alias="extractionInstructions")
    title_abstract_instructions: str = Field(
        default="", alias="titleAbstractInstructions"
    )
    full_text_instructions: str = Field(default="", alias="fullTextInstructions")
    validation_instructions: str = Field(default="", alias="validationInstructions")


class HighlightKeywordsUpdate(ApiModel):
    keywords: list[str] = Field(default_factory=list)


class HighlightKeywordsResponse(ApiModel):
    keywords: list[str]


class ProjectReopen(BaseModel):
    target_stage: ProjectStage = Field(alias="targetStage")


class ProjectDetailsUpdate(ApiModel):
    name: str = Field(min_length=1, max_length=250)
    description: str | None = None


class ChecklistItem(ApiModel):
    key: str
    label: str
    done: bool
    detail: str


class ChecklistStage(ApiModel):
    stage: ProjectStage
    label: str
    is_current: bool = Field(serialization_alias="isCurrent")
    is_complete: bool = Field(serialization_alias="isComplete")
    items: list[ChecklistItem]
    auto_advances: bool = Field(serialization_alias="autoAdvances")
    action: str | None = None


class ProjectChecklist(ApiModel):
    stage: ProjectStage
    stages: list[ChecklistStage]
