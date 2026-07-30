from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field

from app.projects.models import AllocationMode, CriterionKind, ProjectStage, ResolutionMethod, ReviewType, ScreeningStage


class ApiModel(BaseModel):
    model_config = ConfigDict(populate_by_name=True, from_attributes=True, use_enum_values=True)


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


class MembershipCreate(ApiModel):
    user_id: str = Field(alias="userId")
    can_title_abstract_screen: bool = Field(default=False, alias="canTitleAbstractScreen")
    can_full_text_screen: bool = Field(default=False, alias="canFullTextScreen")
    can_extract: bool = Field(default=False, alias="canExtract")
    can_assess_quality: bool = Field(default=False, alias="canAssessQuality")
    can_adjudicate: bool = Field(default=False, alias="canAdjudicate")


class MembershipResponse(ApiModel):
    id: str
    user_id: str = Field(serialization_alias="userId")
    can_title_abstract_screen: bool = Field(serialization_alias="canTitleAbstractScreen")
    can_full_text_screen: bool = Field(serialization_alias="canFullTextScreen")
    can_extract: bool = Field(serialization_alias="canExtract")
    can_assess_quality: bool = Field(serialization_alias="canAssessQuality")
    can_adjudicate: bool = Field(serialization_alias="canAdjudicate")


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
    conflict_resolution: ResolutionMethod = Field(serialization_alias="conflictResolution")
    uncertain_resolution: ResolutionMethod = Field(serialization_alias="uncertainResolution")


class ExclusionReasonCreate(ApiModel):
    label: str = Field(min_length=1, max_length=300)
    position: int | None = Field(default=None, ge=0)


class ExclusionReasonResponse(ApiModel):
    id: str
    stage: ScreeningStage
    label: str
    position: int


class ProjectDetail(ProjectSummary):
    memberships: list[MembershipResponse]
    research_questions: list[ResearchQuestionResponse] = Field(serialization_alias="researchQuestions")
    criteria: list[CriterionResponse]
    screening_configs: list[ScreeningConfigResponse] = Field(serialization_alias="screeningConfigs")
    exclusion_reasons: list[ExclusionReasonResponse] = Field(serialization_alias="exclusionReasons")

class ProjectReopen(BaseModel):
    target_stage: ProjectStage = Field(alias="targetStage")


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
