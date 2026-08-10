from datetime import date, datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class ApiModel(BaseModel):
    model_config = ConfigDict(
        populate_by_name=True, from_attributes=True, use_enum_values=True
    )


class SearchSourceCreate(ApiModel):
    source_name: str = Field(alias="sourceName", min_length=1, max_length=200)
    query: str = Field(min_length=1)
    search_date: date = Field(alias="searchDate")
    filters: str | None = None
    exported_result_count: int = Field(default=0, alias="exportedResultCount", ge=0)


class ImportBatchSummary(ApiModel):
    id: str
    original_filename: str = Field(serialization_alias="originalFilename")
    status: str
    record_count: int = Field(serialization_alias="recordCount")
    attached_paper_count: int = Field(
        default=0, serialization_alias="attachedPaperCount"
    )
    completed_at: datetime | None = Field(serialization_alias="completedAt")


class SearchCreatorSummary(ApiModel):
    id: str
    display_name: str = Field(serialization_alias="displayName")
    username: str


class SearchSourceResponse(ApiModel):
    id: str
    source_name: str = Field(serialization_alias="sourceName")
    query: str
    search_date: date = Field(serialization_alias="searchDate")
    filters: str | None
    exported_result_count: int = Field(serialization_alias="exportedResultCount")
    created_at: datetime = Field(serialization_alias="createdAt")
    created_by: SearchCreatorSummary = Field(serialization_alias="createdBy")
    import_batches: list[ImportBatchSummary] = Field(
        default_factory=list, serialization_alias="importBatches"
    )


class JobAccepted(ApiModel):
    job_id: str = Field(serialization_alias="jobId")
    import_batch_id: str = Field(serialization_alias="importBatchId")


class JobRestartRequest(ApiModel):
    job_ids: list[str] = Field(min_length=1, alias="jobIds")


class PdfMatchResolve(ApiModel):
    item_id: str = Field(alias="itemId")
    publication_id: str | None = Field(default=None, alias="publicationId")
    action: str


class JobResponse(ApiModel):
    id: str
    job_type: str = Field(serialization_alias="jobType")
    status: str
    progress_current: int = Field(serialization_alias="progressCurrent")
    progress_total: int = Field(serialization_alias="progressTotal")
    progress_message: str | None = Field(serialization_alias="progressMessage")
    error_message: str | None = Field(serialization_alias="errorMessage")
    result: dict[str, Any] | None
    created_at: datetime = Field(serialization_alias="createdAt")
    completed_at: datetime | None = Field(serialization_alias="completedAt")


class JobStageSummary(ApiModel):
    stage: str
    completed: int
    total: int
    active: bool


class JobErrorResponse(ApiModel):
    job_id: str = Field(serialization_alias="jobId")
    job_type: str = Field(serialization_alias="jobType")
    job_label: str = Field(serialization_alias="jobLabel")
    affected_stage: str = Field(serialization_alias="affectedStage")
    project_id: str | None = Field(serialization_alias="projectId")
    project_name: str | None = Field(serialization_alias="projectName")
    project_stage: str | None = Field(serialization_alias="projectStage")
    attempt: int
    max_attempts: int = Field(serialization_alias="maxAttempts")
    queued_at: datetime = Field(serialization_alias="queuedAt")
    started_at: datetime | None = Field(serialization_alias="startedAt")
    failed_at: datetime | None = Field(serialization_alias="failedAt")
    context: dict[str, str | int | bool | None]
    error_type: str | None = Field(serialization_alias="errorType")
    error_message: str | None = Field(serialization_alias="errorMessage")
    error_details: str | None = Field(serialization_alias="errorDetails")
