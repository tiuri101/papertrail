from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, File, Form, UploadFile, status
from sqlalchemy.orm import Session

from app.accounts.dependencies import require_csrf
from app.accounts.models import User, UserSession
from app.api.errors import DomainError
from app.core.config import get_settings
from app.db.session import get_db
from app.pdf_acquisition import service
from app.pdf_acquisition.dependencies import get_current_browser_agent
from app.pdf_acquisition.models import BrowserAgent, PdfRetrievalBatch
from app.pdf_acquisition.schemas import (
    AgentMeResponse,
    BatchCreatedResponse,
    BatchCreateRequest,
    BatchResponse,
    BrowserAgentResponse,
    ClaimResponse,
    JobResponse,
    JobStateUpdate,
    MissingFullTextCountResponse,
    PairingSecretResponse,
    PairRequest,
    PairResponse,
    PendingJobsCountResponse,
)
from app.projects.dependencies import require_full_text_reviewer_csrf
from app.projects.service import get_project, require_project_access

user_router = APIRouter(prefix="/browser-agents", tags=["browser agents"])
agent_router = APIRouter(prefix="/browser-agent", tags=["browser agent"])
batch_router = APIRouter(tags=["pdf retrieval batches"])


def _batch_response(db: Session, batch: PdfRetrievalBatch) -> dict[str, Any]:
    progress = service.batch_progress(db, batch)
    attention = [
        service.job_summary_data(job) for job in service.batch_attention_jobs(db, batch)
    ]
    return {
        "id": batch.id,
        "project_id": batch.project_id,
        "status": batch.status.value,
        "created_at": batch.created_at,
        "completed_at": batch.completed_at,
        "cancelled_at": batch.cancelled_at,
        "progress": progress,
        "attention_jobs": attention,
        "succeeded_publication_ids": service.batch_succeeded_publication_ids(db, batch),
    }


# --- Authenticated-user pairing & agent management ---------------------------------


@user_router.post("/pairing-secrets", response_model=PairingSecretResponse)
def create_pairing_secret(
    session: UserSession = Depends(require_csrf),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    settings = get_settings()
    _pairing, raw_secret = service.create_pairing_secret(db, session.user)
    db.commit()
    return {
        "pairing_secret": raw_secret,
        "expires_at": _pairing.expires_at,
        "server_url": settings.public_base_url,
    }


@user_router.get("", response_model=list[BrowserAgentResponse])
def list_browser_agents(
    session: UserSession = Depends(require_csrf),
    db: Session = Depends(get_db),
) -> list[BrowserAgent]:
    return service.list_agents(db, session.user)


@user_router.delete("/{agent_id}", status_code=status.HTTP_204_NO_CONTENT)
def revoke_browser_agent(
    agent_id: str,
    session: UserSession = Depends(require_csrf),
    db: Session = Depends(get_db),
) -> None:
    service.revoke_agent(db, session.user, agent_id)
    db.commit()


@user_router.post("/pair", response_model=PairResponse, status_code=status.HTTP_201_CREATED)
def pair_browser_agent(
    payload: PairRequest,
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    """Unauthenticated on purpose: the one-time pairing secret itself is the
    credential proving the extension belongs to whoever generated it in the
    Papertrail UI. No session cookie exists yet on a fresh browser install."""
    agent, raw_token = service.consume_pairing(
        db,
        payload.pairing_secret,
        device_name=payload.device_name,
        extension_version=payload.extension_version,
    )
    db.commit()
    return {
        "agent_token": raw_token,
        "agent": {
            "id": agent.id,
            "display_name": agent.display_name,
            "extension_version": agent.extension_version,
        },
    }


# --- Agent-authenticated endpoints --------------------------------------------------


@agent_router.get("/me", response_model=AgentMeResponse)
def agent_me(
    agent: BrowserAgent = Depends(get_current_browser_agent),
    db: Session = Depends(get_db),
) -> BrowserAgent:
    db.commit()
    return agent


@agent_router.get("/retrieval-jobs/pending-count", response_model=PendingJobsCountResponse)
def pending_retrieval_jobs_count(
    agent: BrowserAgent = Depends(get_current_browser_agent),
    db: Session = Depends(get_db),
) -> dict[str, int]:
    """Cheap check the extension can poll periodically in the background
    (e.g. via chrome.alarms) to show a badge count, without claiming
    anything or requiring the retrieval page to be open."""
    count = service.count_claimable_jobs(db, agent)
    db.commit()
    return {"pending_count": count}


@agent_router.post("/retrieval-jobs/claim", response_model=ClaimResponse | None)
def claim_retrieval_job(
    agent: BrowserAgent = Depends(get_current_browser_agent),
    db: Session = Depends(get_db),
) -> dict[str, Any] | None:
    settings = get_settings()
    job = service.claim_next_job(db, agent)
    db.commit()
    if job is None:
        return None
    publication = job.publication
    return {
        "job_id": job.id,
        "batch_id": job.batch_id,
        "project_id": job.project_id,
        "publication": {
            "id": publication.id,
            "title": publication.title,
            "doi": publication.doi,
            "publisher_url": publication.publisher_url,
        },
        "max_pdf_bytes": settings.max_pdf_size_mb * 1024 * 1024,
        "lease_until": job.lease_until,
    }


@agent_router.post(
    "/retrieval-jobs/{job_id}/state", response_model=JobResponse
)
def update_retrieval_job_state(
    job_id: str,
    payload: JobStateUpdate,
    agent: BrowserAgent = Depends(get_current_browser_agent),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    job = service.get_agent_job(db, agent, job_id)
    job = service.apply_job_state_update(
        db,
        job,
        agent,
        status=payload.status,
        http_status=payload.http_status,
        error_code=payload.error_code,
        error_message=payload.error_message,
        resolved_landing_url=payload.resolved_landing_url,
        resolved_pdf_url=payload.resolved_pdf_url,
    )
    db.commit()
    return {
        "id": job.id,
        "batch_id": job.batch_id,
        "status": job.status.value,
        "error_code": job.error_code,
        "error_message": job.error_message,
        "lease_until": job.lease_until,
    }


@agent_router.post("/retrieval-jobs/{job_id}/upload", response_model=JobResponse)
async def upload_retrieval_job_pdf(
    job_id: str,
    file: UploadFile = File(...),
    source_url: str | None = Form(default=None),
    landing_url: str | None = Form(default=None),
    agent: BrowserAgent = Depends(get_current_browser_agent),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    job = service.get_agent_job(db, agent, job_id)
    job = await service.upload_job_pdf(
        db, job, agent, file, source_url=source_url, landing_url=landing_url
    )
    db.commit()
    return {
        "id": job.id,
        "batch_id": job.batch_id,
        "status": job.status.value,
        "error_code": job.error_code,
        "error_message": job.error_message,
        "lease_until": job.lease_until,
    }


@agent_router.post("/retrieval-jobs/{job_id}/retry", response_model=JobResponse)
def retry_retrieval_job(
    job_id: str,
    agent: BrowserAgent = Depends(get_current_browser_agent),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    job = service.get_agent_job(db, agent, job_id)
    retried = service.retry_failed_jobs(db, job.batch, agent.user_id, job_ids=[job.id])
    if retried == 0:
        raise DomainError("This retrieval job cannot be retried")
    db.commit()
    db.refresh(job)
    return {
        "id": job.id,
        "batch_id": job.batch_id,
        "status": job.status.value,
        "error_code": job.error_code,
        "error_message": job.error_message,
        "lease_until": job.lease_until,
    }


# --- Project batch endpoints (Papertrail web UI) ------------------------------------


@batch_router.post(
    "/projects/{project_id}/pdf-retrieval-batches",
    response_model=BatchCreatedResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_retrieval_batch(
    project_id: str,
    payload: BatchCreateRequest,
    reviewer: User = Depends(require_full_text_reviewer_csrf),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    project = get_project(db, project_id)
    batch = service.create_batch(db, project, reviewer, payload.publication_ids)
    response = _batch_response(db, batch)
    db.commit()
    return {"batch": response, "eligible_publication_count": response["progress"]["total"]}


@batch_router.get(
    "/projects/{project_id}/pdf-retrieval-batches", response_model=list[BatchResponse]
)
def list_retrieval_batches(
    project_id: str,
    session: UserSession = Depends(require_csrf),
    db: Session = Depends(get_db),
) -> list[dict[str, Any]]:
    require_project_access(db, project_id, session.user)
    return [
        _batch_response(db, batch) for batch in service.list_batches(db, project_id)
    ]


@batch_router.get(
    "/projects/{project_id}/pdf-retrieval-batches/missing-count",
    response_model=MissingFullTextCountResponse,
)
def missing_full_text_count(
    project_id: str,
    session: UserSession = Depends(require_csrf),
    db: Session = Depends(get_db),
) -> dict[str, int]:
    require_project_access(db, project_id, session.user)
    return {"missing_count": service.missing_full_text_count(db, project_id)}


@batch_router.get(
    "/projects/{project_id}/pdf-retrieval-batches/{batch_id}",
    response_model=BatchResponse,
)
def get_retrieval_batch(
    project_id: str,
    batch_id: str,
    session: UserSession = Depends(require_csrf),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    require_project_access(db, project_id, session.user)
    batch = service.get_batch(db, project_id, batch_id)
    return _batch_response(db, batch)


@batch_router.post(
    "/projects/{project_id}/pdf-retrieval-batches/{batch_id}/cancel",
    response_model=BatchResponse,
)
def cancel_retrieval_batch(
    project_id: str,
    batch_id: str,
    reviewer: User = Depends(require_full_text_reviewer_csrf),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    batch = service.get_batch(db, project_id, batch_id)
    service.cancel_batch(db, batch, reviewer.id)
    response = _batch_response(db, batch)
    db.commit()
    return response


@batch_router.post(
    "/projects/{project_id}/pdf-retrieval-batches/{batch_id}/retry-failed",
    response_model=BatchResponse,
)
def retry_failed_retrieval_jobs(
    project_id: str,
    batch_id: str,
    reviewer: User = Depends(require_full_text_reviewer_csrf),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    batch = service.get_batch(db, project_id, batch_id)
    service.retry_failed_jobs(db, batch, reviewer.id)
    response = _batch_response(db, batch)
    db.commit()
    return response


router = APIRouter()
router.include_router(user_router)
router.include_router(agent_router)
router.include_router(batch_router)
