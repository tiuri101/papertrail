from datetime import date, datetime

from pydantic import BaseModel, ConfigDict, Field


class ApiModel(BaseModel):
    model_config = ConfigDict(populate_by_name=True, from_attributes=True, use_enum_values=True)


class SearchSourceCreate(ApiModel):
    source_name: str = Field(alias="sourceName", min_length=1, max_length=200)
    query: str = Field(min_length=1)
    search_date: date = Field(alias="searchDate")
    filters: str | None = None
    exported_result_count: int = Field(default=0, alias="exportedResultCount", ge=0)


class SearchSourceResponse(ApiModel):
    id: str
    source_name: str = Field(serialization_alias="sourceName")
    query: str
    search_date: date = Field(serialization_alias="searchDate")
    filters: str | None
    exported_result_count: int = Field(serialization_alias="exportedResultCount")


class JobAccepted(ApiModel):
    job_id: str = Field(serialization_alias="jobId")
    import_batch_id: str = Field(serialization_alias="importBatchId")


class JobResponse(ApiModel):
    id: str
    job_type: str = Field(serialization_alias="jobType")
    status: str
    progress_current: int = Field(serialization_alias="progressCurrent")
    progress_total: int = Field(serialization_alias="progressTotal")
    progress_message: str | None = Field(serialization_alias="progressMessage")
    error_message: str | None = Field(serialization_alias="errorMessage")
    result: dict | None
    created_at: datetime = Field(serialization_alias="createdAt")
    completed_at: datetime | None = Field(serialization_alias="completedAt")
