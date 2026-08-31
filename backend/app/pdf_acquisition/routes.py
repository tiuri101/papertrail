from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, File, Form, Query, UploadFile, status
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from app.accounts.dependencies import get_current_user, require_csrf
from app.accounts.models import User, UserSession
from app.api.errors import ConflictError, DomainError, NotFoundError
from app.core.config import get_settings
from app.db.session import get_db
from app.instance_settings.service import effective_instance_settings
from app.pdf_acquisition import service
from app.pdf_acquisition.dependencies import get_current_browser_agent
from app.pdf_acquisition.models import BatchStatus, BrowserAgent, PdfRetrievalBatch
from app.pdf_acquisition.schemas import (
    AgentMeResponse,
    AgentProjectResponse,
    BatchCreatedResponse,
    BatchCreateRequest,
    BatchResponse,
    BrowserAgentResponse,
    CaptureAttachResponse,
    ClaimResponse,
    JobResponse,
    JobStateUpdate,
    MissingFullTextCountResponse,
    PairingSecretResponse,
    PairRequest,
    PairResponse,
    PdfDetectResponse,
    PendingJobsCountResponse,
    PublicationPickerResult,
)
from app.projects.dependencies import require_full_text_reviewer_csrf
from app.projects.service import get_project, require_project_access
from app.publications.schemas import PublicationCreate, PublicationResponse

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
    settings = effective_instance_settings(db)
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


@user_router.get("/extension-download")
def download_browser_extension(
    user: User = Depends(get_current_user),
) -> FileResponse:
    """Serve the Browser Helper build baked into this image (backend/Dockerfile).

    Not present outside a Docker deployment, so a source/dev backend reports 404
    here -- reviewers there instead use the extension straight from
    browser-extension/dist per docs/local-development.md.
    """
    zip_path = get_settings().browser_extension_zip_path
    if not zip_path.is_file():
        raise NotFoundError("Browser extension package is not available on this server")
    return FileResponse(
        zip_path,
        filename="papertrail-browser-extension.zip",
        media_type="application/zip",
    )


@user_router.delete("/{agent_id}", status_code=status.HTTP_204_NO_CONTENT)
def revoke_browser_agent(
    agent_id: str,
    session: UserSession = Depends(require_csrf),
    db: Session = Depends(get_db),
) -> None:
    service.revoke_agent(db, session.user, agent_id)
    db.commit()


@user_router.post(
    "/pair", response_model=PairResponse, status_code=status.HTTP_201_CREATED
)
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


@agent_router.get(
    "/retrieval-jobs/pending-count", response_model=PendingJobsCountResponse
)
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
    settings = effective_instance_settings(db)
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


@agent_router.post("/retrieval-jobs/{job_id}/state", response_model=JobResponse)
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
    if job.batch.status == BatchStatus.CANCELLED:
        # A manager cancelled this batch; a helper must not resurrect it.
        raise ConflictError("This retrieval batch has been cancelled")
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


# --- Manual capture (browser extension, ad-hoc tab capture) ------------------------
#
# Independent of the PdfRetrievalJob flow above: the reviewer is looking at a
# PDF right now and wants it attached, rather than the backend having
# assigned a job for it. Still bearer-authenticated via get_current_browser_agent
# and still registered on agent_router only -- see the module docstring on
# get_current_browser_agent for why a BrowserAgent token must never reach
# any endpoint outside this router.


@agent_router.get("/projects", response_model=list[AgentProjectResponse])
def list_agent_projects(
    agent: BrowserAgent = Depends(get_current_browser_agent),
    db: Session = Depends(get_db),
) -> list[Any]:
    projects = service.list_accessible_projects(db, agent)
    db.commit()
    return projects


@agent_router.get(
    "/projects/{project_id}/publications/search",
    response_model=list[PublicationPickerResult],
)
def search_agent_publications(
    project_id: str,
    q: str = Query(default="", max_length=500),
    agent: BrowserAgent = Depends(get_current_browser_agent),
    db: Session = Depends(get_db),
) -> list[Any]:
    results = service.search_publications_for_agent(db, agent, project_id, q)
    db.commit()
    return results


@agent_router.post(
    "/projects/{project_id}/publications",
    response_model=PublicationResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_agent_publication(
    project_id: str,
    payload: PublicationCreate,
    agent: BrowserAgent = Depends(get_current_browser_agent),
    db: Session = Depends(get_db),
) -> Any:
    publication = service.create_agent_publication(
        db, agent, project_id, payload.model_dump(exclude_unset=True)
    )
    db.commit()
    return publication


@agent_router.post("/pdf-captures/detect", response_model=PdfDetectResponse)
async def detect_pdf_capture(
    project_id: str = Form(...),
    file: UploadFile = File(...),
    agent: BrowserAgent = Depends(get_current_browser_agent),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    result = await service.detect_manual_capture(db, agent, project_id, file)
    db.commit()
    return {
        "detected_doi": result.detected_doi,
        "detected_title": result.detected_title,
        "detected_authors": result.detected_authors,
        "detected_year": result.detected_year,
        "ambiguous": result.ambiguous,
        "match": (
            {
                "id": result.match.publication_id,
                "title": result.match.title,
                "authors": result.match.authors,
                "publication_year": result.match.publication_year,
                "doi": result.match.doi,
            }
            if result.match
            else None
        ),
    }


@agent_router.post(
    "/publications/{publication_id}/pdf-captures", response_model=CaptureAttachResponse
)
async def upload_pdf_capture(
    publication_id: str,
    file: UploadFile = File(...),
    replace: bool = Form(default=False),
    agent: BrowserAgent = Depends(get_current_browser_agent),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    document = await service.upload_manual_capture(
        db, agent, publication_id, file, replace=replace
    )
    db.commit()
    return {
        "document_id": document.id,
        "publication_id": document.publication_id,
        "title": document.publication.title if document.publication else "",
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
    return {
        "batch": response,
        "eligible_publication_count": response["progress"]["total"],
    }


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
