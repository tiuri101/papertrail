"""Background-job response schemas.

``JobResponse`` is deliberately self-sanitizing: the redaction runs inside
``model_validator``, not in the route handlers, so every current and future
endpoint that serializes a ``BackgroundJob`` through this schema is covered
whether or not its author remembered to think about it. The privileged
counterpart is ``JobErrorResponse``, which the manager/administrator-gated
``GET /jobs/{job_id}/error`` endpoint fills in.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import Field, model_validator

from app.api.schemas import EnumApiModel as ApiModel
from app.jobs.sanitize import public_error_message, public_job_result


class JobResponse(ApiModel):
    """The member-visible view of a background job.

    Carries status, progress, retry-independent timestamps and the handler's
    own result payload -- never a traceback, stack frame, filesystem path,
    SQL statement or internal hostname. See ``app.jobs.sanitize``.
    """

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

    @model_validator(mode="after")
    def _redact_diagnostics(self) -> JobResponse:
        self.result = public_job_result(self.result)
        self.error_message = public_error_message(self.error_message)
        return self


class JobErrorResponse(ApiModel):
    """The manager/administrator diagnostic report for a failed job.

    ``error_details`` (the raw traceback) and the unredacted ``error_message``
    are only populated for a global administrator or a manager of the job's
    project -- see ``app.jobs.routes.get_job_error``.
    """

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
