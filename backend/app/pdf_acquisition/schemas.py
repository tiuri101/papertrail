from __future__ import annotations

from datetime import datetime

from pydantic import Field

from app.api.schemas import EnumApiModel as ApiModel

# --- Pairing (authenticated user) -------------------------------------------------


class PairingSecretResponse(ApiModel):
    pairing_secret: str = Field(serialization_alias="pairingSecret")
    expires_at: datetime = Field(serialization_alias="expiresAt")
    server_url: str = Field(serialization_alias="serverUrl")


# --- Pairing (unauthenticated extension) ------------------------------------------


class PairRequest(ApiModel):
    pairing_secret: str = Field(alias="pairingSecret")
    device_name: str = Field(alias="deviceName")
    extension_version: str | None = Field(default=None, alias="extensionVersion")


class PairedAgentSummary(ApiModel):
    id: str
    display_name: str = Field(serialization_alias="displayName")
    extension_version: str | None = Field(serialization_alias="extensionVersion")


class PairResponse(ApiModel):
    agent_token: str = Field(serialization_alias="agentToken")
    agent: PairedAgentSummary


# --- Browser agent management (authenticated user) ---------------------------------


class BrowserAgentResponse(ApiModel):
    id: str
    display_name: str = Field(serialization_alias="displayName")
    extension_version: str | None = Field(serialization_alias="extensionVersion")
    created_at: datetime = Field(serialization_alias="createdAt")
    last_seen_at: datetime | None = Field(serialization_alias="lastSeenAt")
    revoked_at: datetime | None = Field(serialization_alias="revokedAt")


# --- Agent-authenticated endpoints --------------------------------------------------


class AgentMeResponse(ApiModel):
    id: str
    display_name: str = Field(serialization_alias="displayName")
    extension_version: str | None = Field(serialization_alias="extensionVersion")


class PendingJobsCountResponse(ApiModel):
    pending_count: int = Field(serialization_alias="pendingCount")


class ClaimPublication(ApiModel):
    id: str
    title: str
    doi: str | None
    publisher_url: str | None = Field(serialization_alias="publisherUrl")


class ClaimResponse(ApiModel):
    job_id: str = Field(serialization_alias="jobId")
    batch_id: str = Field(serialization_alias="batchId")
    project_id: str = Field(serialization_alias="projectId")
    publication: ClaimPublication
    max_pdf_bytes: int = Field(serialization_alias="maxPdfBytes")
    lease_until: datetime = Field(serialization_alias="leaseUntil")


class JobStateUpdate(ApiModel):
    status: str
    http_status: int | None = Field(default=None, alias="httpStatus")
    error_code: str | None = Field(default=None, alias="errorCode")
    error_message: str | None = Field(default=None, alias="errorMessage")
    resolved_landing_url: str | None = Field(default=None, alias="resolvedLandingUrl")
    resolved_pdf_url: str | None = Field(default=None, alias="resolvedPdfUrl")


class JobResponse(ApiModel):
    id: str
    batch_id: str = Field(serialization_alias="batchId")
    status: str
    error_code: str | None = Field(serialization_alias="errorCode")
    error_message: str | None = Field(serialization_alias="errorMessage")
    lease_until: datetime | None = Field(serialization_alias="leaseUntil")


# --- Batches (authenticated user) ---------------------------------------------------


class BatchCreateRequest(ApiModel):
    publication_ids: list[str] | None = Field(default=None, alias="publicationIds")


class MissingFullTextCountResponse(ApiModel):
    missing_count: int = Field(serialization_alias="missingCount")


class BatchProgress(ApiModel):
    total: int
    queued: int
    active: int
    succeeded: int
    needs_authentication: int = Field(serialization_alias="needsAuthentication")
    not_found: int = Field(serialization_alias="notFound")
    access_denied: int = Field(serialization_alias="accessDenied")
    invalid_response: int = Field(serialization_alias="invalidResponse")
    failed: int
    cancelled: int
    skipped_existing: int = Field(serialization_alias="skippedExisting")
    processed: int


class JobSummary(ApiModel):
    job_id: str = Field(serialization_alias="jobId")
    publication_id: str = Field(serialization_alias="publicationId")
    title: str
    status: str
    error_code: str | None = Field(serialization_alias="errorCode")
    error_message: str | None = Field(serialization_alias="errorMessage")
    resolved_landing_url: str | None = Field(serialization_alias="resolvedLandingUrl")


class BatchResponse(ApiModel):
    id: str
    project_id: str = Field(serialization_alias="projectId")
    status: str
    created_at: datetime = Field(serialization_alias="createdAt")
    completed_at: datetime | None = Field(serialization_alias="completedAt")
    cancelled_at: datetime | None = Field(serialization_alias="cancelledAt")
    progress: BatchProgress
    attention_jobs: list[JobSummary] = Field(serialization_alias="attentionJobs")
    succeeded_publication_ids: list[str] = Field(
        serialization_alias="succeededPublicationIds"
    )


class BatchCreatedResponse(ApiModel):
    batch: BatchResponse
    eligible_publication_count: int = Field(
        serialization_alias="eligiblePublicationCount"
    )


# --- Manual capture (agent-authenticated) -------------------------------------------


class AgentProjectResponse(ApiModel):
    id: str
    name: str


class PublicationPickerResult(ApiModel):
    id: str
    title: str
    authors: str | None
    publication_year: int | None = Field(serialization_alias="publicationYear")
    doi: str | None


class PdfDetectResponse(ApiModel):
    detected_doi: str | None = Field(serialization_alias="detectedDoi")
    detected_title: str | None = Field(serialization_alias="detectedTitle")
    match: PublicationPickerResult | None
    ambiguous: bool


class CaptureAttachResponse(ApiModel):
    document_id: str = Field(serialization_alias="documentId")
    publication_id: str = Field(serialization_alias="publicationId")
    title: str
