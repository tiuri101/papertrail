from __future__ import annotations

import secrets
from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi import UploadFile
from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import Session, joinedload

from app.accounts.models import User
from app.accounts.service import hash_token
from app.api.errors import ConflictError, DomainError, ForbiddenError, NotFoundError
from app.audit.service import record_audit
from app.core.config import get_settings
from app.core.time import utcnow
from app.fulltext.documents import active_document, attach_staged_pdf
from app.fulltext.models import DocumentSource, FullTextRetrieval, PublicationDocument
from app.fulltext.models import RetrievalStatus as HumanRetrievalStatus
from app.fulltext.service import CLAIMABLE_STATUSES, set_retrieval_status
from app.fulltext.storage import discard_pdf, stage_pdf_upload
from app.instance_settings.service import effective_instance_settings
from app.pdf_acquisition.models import (
    ACTIVE_JOB_STATUSES,
    IN_FLIGHT_JOB_STATUSES,
    RETRYABLE_JOB_STATUSES,
    BatchStatus,
    BrowserAgent,
    BrowserAgentPairing,
    PdfRetrievalBatch,
    PdfRetrievalJob,
    RetrievalJobStatus,
)
from app.projects.models import Project, ProjectMembership
from app.projects.service import is_project_manager

ERROR_MESSAGE_MAX_LENGTH = 500

# Transitions the extension is allowed to report through the generic /state
# endpoint. SUCCEEDED and SKIPPED_EXISTING are only ever reached through the
# upload endpoint, which independently verifies the PDF -- an agent cannot
# self-report success without actually uploading a validated file.
_ALLOWED_AGENT_TRANSITIONS: dict[RetrievalJobStatus, set[RetrievalJobStatus]] = {
    RetrievalJobStatus.CLAIMED: {
        RetrievalJobStatus.RETRIEVING,
        RetrievalJobStatus.UPLOADING,
        RetrievalJobStatus.NEEDS_AUTHENTICATION,
        RetrievalJobStatus.NOT_FOUND,
        RetrievalJobStatus.ACCESS_DENIED,
        RetrievalJobStatus.INVALID_RESPONSE,
        RetrievalJobStatus.FAILED,
    },
    RetrievalJobStatus.RETRIEVING: {
        RetrievalJobStatus.UPLOADING,
        RetrievalJobStatus.NEEDS_AUTHENTICATION,
        RetrievalJobStatus.NOT_FOUND,
        RetrievalJobStatus.ACCESS_DENIED,
        RetrievalJobStatus.INVALID_RESPONSE,
        RetrievalJobStatus.FAILED,
    },
    RetrievalJobStatus.UPLOADING: {
        RetrievalJobStatus.FAILED,
    },
}


def _aware(value: datetime) -> datetime:
    return value if value.tzinfo is not None else value.replace(tzinfo=UTC)


# --- Pairing -------------------------------------------------------------------


def create_pairing_secret(db: Session, user: User) -> tuple[BrowserAgentPairing, str]:
    settings = get_settings()
    now = utcnow()
    raw_secret = secrets.token_urlsafe(32)
    pairing = BrowserAgentPairing(
        user_id=user.id,
        token_hash=hash_token(raw_secret),
        created_at=now,
        expires_at=now + timedelta(minutes=settings.browser_agent_pairing_ttl_minutes),
    )
    db.add(pairing)
    db.flush()
    record_audit(
        db,
        action="browser_agent.pairing_created",
        entity_type="browser_agent_pairing",
        entity_id=pairing.id,
        actor_id=user.id,
        summary="Created a browser helper pairing secret",
    )
    return pairing, raw_secret


def consume_pairing(
    db: Session,
    raw_secret: str | None,
    *,
    device_name: str,
    extension_version: str | None,
) -> tuple[BrowserAgent, str]:
    invalid = ForbiddenError("Invalid or expired pairing secret")
    if not raw_secret:
        raise invalid
    pairing = db.scalar(
        select(BrowserAgentPairing).where(
            BrowserAgentPairing.token_hash == hash_token(raw_secret)
        )
    )
    now = utcnow()
    if (
        pairing is None
        or pairing.used_at is not None
        or _aware(pairing.expires_at) <= now
    ):
        raise invalid
    user = db.get(User, pairing.user_id)
    if user is None or not user.is_active:
        raise invalid

    pairing.used_at = now
    display_name = (device_name or "Chrome Browser Helper").strip()[:200]
    display_name = display_name or "Chrome Browser Helper"
    raw_token = secrets.token_urlsafe(48)
    agent = BrowserAgent(
        user_id=user.id,
        display_name=display_name,
        token_hash=hash_token(raw_token),
        extension_version=(extension_version or "").strip()[:50] or None,
        last_seen_at=now,
    )
    db.add(agent)
    db.flush()
    record_audit(
        db,
        action="browser_agent.paired",
        entity_type="browser_agent",
        entity_id=agent.id,
        actor_id=user.id,
        summary=f"Paired browser helper '{display_name}'",
        metadata={"extensionVersion": agent.extension_version},
    )
    return agent, raw_token


def list_agents(db: Session, user: User) -> list[BrowserAgent]:
    return list(
        db.scalars(
            select(BrowserAgent)
            .where(BrowserAgent.user_id == user.id, BrowserAgent.revoked_at.is_(None))
            .order_by(BrowserAgent.created_at.desc())
        )
    )


def revoke_agent(db: Session, user: User, agent_id: str) -> BrowserAgent:
    agent = db.get(BrowserAgent, agent_id)
    if agent is None or agent.user_id != user.id:
        raise NotFoundError("Browser helper not found")
    if agent.revoked_at is None:
        agent.revoked_at = utcnow()
        record_audit(
            db,
            action="browser_agent.revoked",
            entity_type="browser_agent",
            entity_id=agent.id,
            actor_id=user.id,
            summary=f"Revoked browser helper '{agent.display_name}'",
        )
        db.flush()
        # Don't leave the deauthorized helper's in-flight jobs claimed until
        # their leases run out -- requeue them for whoever can still work them.
        release_claims_for_agent(db, [agent.id])
    return agent


def revoke_all_agents_for_user(
    db: Session, user: User, *, actor_id: str | None = None
) -> int:
    """Used by account lifecycle flows (deactivation, forced password reset)
    so a browser helper can't keep pulling retrieval jobs after the account
    it's attached to is no longer trusted."""
    agents = list(
        db.scalars(
            select(BrowserAgent).where(
                BrowserAgent.user_id == user.id, BrowserAgent.revoked_at.is_(None)
            )
        )
    )
    now = utcnow()
    for agent in agents:
        agent.revoked_at = now
        record_audit(
            db,
            action="browser_agent.revoked",
            entity_type="browser_agent",
            entity_id=agent.id,
            actor_id=actor_id,
            summary=f"Revoked browser helper '{agent.display_name}'",
        )
    if agents:
        db.flush()
        release_claims_for_agent(db, [agent.id for agent in agents])
    return len(agents)


def authenticate_agent(db: Session, raw_token: str | None) -> BrowserAgent | None:
    if not raw_token:
        return None
    agent = db.scalar(
        select(BrowserAgent).where(BrowserAgent.token_hash == hash_token(raw_token))
    )
    if agent is None or agent.revoked_at is not None:
        return None
    user = db.get(User, agent.user_id)
    if user is None or not user.is_active:
        return None
    agent.last_seen_at = utcnow()
    db.flush()
    return agent


def _user_has_full_text_access(db: Session, project_id: str, user_id: str) -> bool:
    user = db.get(User, user_id)
    if user is None or not user.is_active:
        return False
    if user.is_admin or is_project_manager(db, project_id, user):
        return True
    membership = db.scalar(
        select(ProjectMembership).where(
            ProjectMembership.project_id == project_id,
            ProjectMembership.user_id == user_id,
        )
    )
    return membership is not None and membership.can_full_text_screen


# --- Batch eligibility & creation -----------------------------------------------


def eligible_publication_ids(
    db: Session, project: Project, publication_ids: list[str] | None = None
) -> list[str]:
    filters = [
        FullTextRetrieval.project_id == project.id,
        FullTextRetrieval.status.in_(CLAIMABLE_STATUSES),
    ]
    if publication_ids is not None:
        filters.append(FullTextRetrieval.publication_id.in_(publication_ids))
    retrievals = list(
        db.scalars(
            select(FullTextRetrieval)
            .where(*filters)
            .order_by(FullTextRetrieval.created_at)
        )
    )
    if not retrievals:
        return []
    candidate_ids = [retrieval.publication_id for retrieval in retrievals]
    active_document_ids = set(
        db.scalars(
            select(PublicationDocument.publication_id).where(
                PublicationDocument.publication_id.in_(candidate_ids),
                PublicationDocument.is_active.is_(True),
            )
        )
    )
    in_flight_ids = set(
        db.scalars(
            select(PdfRetrievalJob.publication_id)
            .join(PdfRetrievalBatch, PdfRetrievalJob.batch_id == PdfRetrievalBatch.id)
            .where(
                PdfRetrievalBatch.project_id == project.id,
                PdfRetrievalBatch.status == BatchStatus.RUNNING,
                PdfRetrievalJob.publication_id.in_(candidate_ids),
                PdfRetrievalJob.status.in_(ACTIVE_JOB_STATUSES),
            )
        )
    )
    return [
        publication_id
        for publication_id in candidate_ids
        if publication_id not in active_document_ids
        and publication_id not in in_flight_ids
    ]


def missing_full_text_count(db: Session, project_id: str) -> int:
    active_document_ids = select(PublicationDocument.publication_id).where(
        PublicationDocument.is_active.is_(True)
    )
    return (
        db.scalar(
            select(func.count())
            .select_from(FullTextRetrieval)
            .where(
                FullTextRetrieval.project_id == project_id,
                FullTextRetrieval.status.in_(CLAIMABLE_STATUSES),
                FullTextRetrieval.publication_id.not_in(active_document_ids),
            )
        )
        or 0
    )


def create_batch(
    db: Session,
    project: Project,
    user: User,
    publication_ids: list[str] | None = None,
) -> PdfRetrievalBatch:
    eligible_ids = eligible_publication_ids(db, project, publication_ids)
    if not eligible_ids:
        raise DomainError(
            "No publications are currently eligible for automated PDF retrieval"
        )
    batch = PdfRetrievalBatch(
        project_id=project.id, created_by_user_id=user.id, status=BatchStatus.RUNNING
    )
    db.add(batch)
    db.flush()
    for publication_id in eligible_ids:
        db.add(
            PdfRetrievalJob(
                batch_id=batch.id,
                project_id=project.id,
                publication_id=publication_id,
                status=RetrievalJobStatus.QUEUED,
            )
        )
    db.flush()
    record_audit(
        db,
        action="pdf_retrieval.batch_started",
        entity_type="pdf_retrieval_batch",
        entity_id=batch.id,
        project_id=project.id,
        actor_id=user.id,
        summary=f"Started PDF retrieval batch for {len(eligible_ids)} publication(s)",
        metadata={"jobCount": len(eligible_ids)},
    )
    return batch


def _has_active_agent(db: Session, user_id: str) -> bool:
    return (
        db.scalar(
            select(BrowserAgent.id).where(
                BrowserAgent.user_id == user_id, BrowserAgent.revoked_at.is_(None)
            )
        )
        is not None
    )


def _pick_auto_queue_owner(
    db: Session, project: Project, preferred_user_id: str | None
) -> str | None:
    """Whose paired browser helper an automatically-queued job should belong
    to. Auto-queueing has no explicit "start a batch" click to attach an
    owner to, so it prefers the reviewer who just made the inclusion
    decision (if they have a live paired agent with access to this project),
    falling back to any other project member who does."""
    if (
        preferred_user_id is not None
        and _has_active_agent(db, preferred_user_id)
        and _user_has_full_text_access(db, project.id, preferred_user_id)
    ):
        return preferred_user_id
    candidate_user_ids = list(
        db.scalars(
            select(BrowserAgent.user_id)
            .where(BrowserAgent.revoked_at.is_(None))
            .distinct()
        )
    )
    for user_id in candidate_user_ids:
        if _user_has_full_text_access(db, project.id, user_id):
            return user_id
    return None


def auto_queue_publication_for_retrieval(
    db: Session,
    project: Project,
    publication_id: str,
    *,
    preferred_user_id: str | None = None,
) -> PdfRetrievalJob | None:
    """Queue a single publication for browser retrieval as soon as it becomes
    eligible (e.g. right after a title/abstract INCLUDE decision), rather
    than waiting for someone to click "Retrieve missing PDFs". A no-op if the
    publication already has an active PDF, is already in flight, or nobody
    currently has a paired browser helper that can reach this project --
    manual batch creation remains available as a fallback for that last
    case."""
    if active_document(db, publication_id) is not None:
        return None

    owner_id = _pick_auto_queue_owner(db, project, preferred_user_id)
    if owner_id is None:
        return None

    batch = db.scalar(
        select(PdfRetrievalBatch)
        .where(
            PdfRetrievalBatch.project_id == project.id,
            PdfRetrievalBatch.status == BatchStatus.RUNNING,
            PdfRetrievalBatch.created_by_user_id == owner_id,
        )
        .order_by(PdfRetrievalBatch.created_at.desc())
    )
    if batch is None:
        batch = PdfRetrievalBatch(
            project_id=project.id,
            created_by_user_id=owner_id,
            status=BatchStatus.RUNNING,
        )
        db.add(batch)
        db.flush()

    existing_job = db.scalar(
        select(PdfRetrievalJob).where(
            PdfRetrievalJob.batch_id == batch.id,
            PdfRetrievalJob.publication_id == publication_id,
        )
    )
    if existing_job is not None:
        if existing_job.status not in RETRYABLE_JOB_STATUSES:
            # Already queued/active/succeeded/skipped/cancelled in this
            # batch -- nothing to do.
            return None
        existing_job.status = RetrievalJobStatus.QUEUED
        existing_job.claimed_by_agent_id = None
        existing_job.claimed_at = None
        existing_job.lease_until = None
        existing_job.completed_at = None
        existing_job.http_status = None
        existing_job.error_code = None
        existing_job.error_message = None
        job = existing_job
    else:
        job = PdfRetrievalJob(
            batch_id=batch.id,
            project_id=project.id,
            publication_id=publication_id,
            status=RetrievalJobStatus.QUEUED,
        )
        db.add(job)

    db.flush()
    record_audit(
        db,
        action="pdf_retrieval.job_auto_queued",
        entity_type="pdf_retrieval_job",
        entity_id=job.id,
        project_id=project.id,
        actor_id=preferred_user_id,
        summary="Automatically queued browser PDF retrieval after inclusion",
        metadata={"publicationId": publication_id, "batchId": batch.id},
    )
    return job


def get_batch(db: Session, project_id: str, batch_id: str) -> PdfRetrievalBatch:
    batch = db.get(PdfRetrievalBatch, batch_id)
    if batch is None or batch.project_id != project_id:
        raise NotFoundError("PDF retrieval batch not found")
    return batch


def list_batches(db: Session, project_id: str) -> list[PdfRetrievalBatch]:
    return list(
        db.scalars(
            select(PdfRetrievalBatch)
            .where(PdfRetrievalBatch.project_id == project_id)
            .order_by(PdfRetrievalBatch.created_at.desc())
        )
    )


def _maybe_complete_batch(db: Session, batch: PdfRetrievalBatch) -> None:
    if batch.status != BatchStatus.RUNNING:
        return
    remaining = db.scalar(
        select(func.count())
        .select_from(PdfRetrievalJob)
        .where(
            PdfRetrievalJob.batch_id == batch.id,
            PdfRetrievalJob.status.in_(ACTIVE_JOB_STATUSES),
        )
    )
    if not remaining:
        batch.status = BatchStatus.COMPLETED
        batch.completed_at = utcnow()
        db.flush()


def cancel_batch(db: Session, batch: PdfRetrievalBatch, user_id: str) -> int:
    if batch.status != BatchStatus.RUNNING:
        raise ConflictError("Only a running retrieval batch can be cancelled")
    now = utcnow()
    batch.status = BatchStatus.CANCELLED
    batch.cancelled_at = now
    open_jobs = list(
        db.scalars(
            select(PdfRetrievalJob).where(
                PdfRetrievalJob.batch_id == batch.id,
                PdfRetrievalJob.status.in_(ACTIVE_JOB_STATUSES),
            )
        )
    )
    for job in open_jobs:
        job.status = RetrievalJobStatus.CANCELLED
        job.completed_at = now
        job.lease_until = None
    db.flush()
    record_audit(
        db,
        action="pdf_retrieval.batch_cancelled",
        entity_type="pdf_retrieval_batch",
        entity_id=batch.id,
        project_id=batch.project_id,
        actor_id=user_id,
        summary="Cancelled PDF retrieval batch",
        metadata={"cancelledJobCount": len(open_jobs)},
    )
    return len(open_jobs)


def retry_failed_jobs(
    db: Session,
    batch: PdfRetrievalBatch,
    user_id: str,
    job_ids: list[str] | None = None,
) -> int:
    query = select(PdfRetrievalJob).where(
        PdfRetrievalJob.batch_id == batch.id,
        PdfRetrievalJob.status.in_(RETRYABLE_JOB_STATUSES),
    )
    if job_ids:
        query = query.where(PdfRetrievalJob.id.in_(job_ids))
    jobs = list(db.scalars(query))
    if not jobs:
        return 0
    for job in jobs:
        job.status = RetrievalJobStatus.QUEUED
        job.claimed_by_agent_id = None
        job.claimed_at = None
        job.lease_until = None
        job.completed_at = None
        job.http_status = None
        job.error_code = None
        job.error_message = None
    if batch.status != BatchStatus.RUNNING:
        batch.status = BatchStatus.RUNNING
        batch.completed_at = None
        batch.cancelled_at = None
    db.flush()
    record_audit(
        db,
        action="pdf_retrieval.job_retried",
        entity_type="pdf_retrieval_batch",
        entity_id=batch.id,
        project_id=batch.project_id,
        actor_id=user_id,
        summary=f"Retried {len(jobs)} failed retrieval job(s)",
        metadata={"retriedJobCount": len(jobs), "jobIds": [job.id for job in jobs]},
    )
    return len(jobs)


def batch_progress(db: Session, batch: PdfRetrievalBatch) -> dict[str, int]:
    rows = db.execute(
        select(PdfRetrievalJob.status, func.count())
        .where(PdfRetrievalJob.batch_id == batch.id)
        .group_by(PdfRetrievalJob.status)
    ).all()
    counts: dict[RetrievalJobStatus, int] = dict.fromkeys(RetrievalJobStatus, 0)
    for status, count in rows:
        counts[RetrievalJobStatus(status)] = int(count)
    total = sum(counts.values())
    queued = counts[RetrievalJobStatus.QUEUED]
    active = (
        counts[RetrievalJobStatus.CLAIMED]
        + counts[RetrievalJobStatus.RETRIEVING]
        + counts[RetrievalJobStatus.UPLOADING]
    )
    return {
        "total": total,
        "queued": queued,
        "active": active,
        "succeeded": counts[RetrievalJobStatus.SUCCEEDED],
        "needs_authentication": counts[RetrievalJobStatus.NEEDS_AUTHENTICATION],
        "not_found": counts[RetrievalJobStatus.NOT_FOUND],
        "access_denied": counts[RetrievalJobStatus.ACCESS_DENIED],
        "invalid_response": counts[RetrievalJobStatus.INVALID_RESPONSE],
        "failed": counts[RetrievalJobStatus.FAILED],
        "cancelled": counts[RetrievalJobStatus.CANCELLED],
        "skipped_existing": counts[RetrievalJobStatus.SKIPPED_EXISTING],
        "processed": total - queued - active,
    }


def batch_attention_jobs(
    db: Session, batch: PdfRetrievalBatch, limit: int = 200
) -> list[PdfRetrievalJob]:
    return list(
        db.scalars(
            select(PdfRetrievalJob)
            .options(joinedload(PdfRetrievalJob.publication))
            .where(
                PdfRetrievalJob.batch_id == batch.id,
                PdfRetrievalJob.status.in_(RETRYABLE_JOB_STATUSES),
            )
            .order_by(PdfRetrievalJob.updated_at.desc())
            .limit(limit)
        )
    )


# --- Claiming --------------------------------------------------------------------


def _claimable_jobs_filter(agent: BrowserAgent, now: datetime) -> list[Any]:
    """Shared eligibility condition for a job this agent could claim right
    now: queued, or claimed/in-flight with an expired lease (abandoned)."""
    return [
        PdfRetrievalBatch.created_by_user_id == agent.user_id,
        PdfRetrievalBatch.status == BatchStatus.RUNNING,
        or_(
            PdfRetrievalJob.status == RetrievalJobStatus.QUEUED,
            and_(
                PdfRetrievalJob.status.in_(IN_FLIGHT_JOB_STATUSES),
                PdfRetrievalJob.lease_until < now,
            ),
        ),
    ]


def count_claimable_jobs(db: Session, agent: BrowserAgent) -> int:
    """A cheap, approximate count for the extension's background polling
    badge -- unlike claim_next_job, this does not re-check per-project
    access, so it may over-count if access was since revoked. That's an
    acceptable inaccuracy for a "you might have work" hint; claiming itself
    still enforces access authoritatively."""
    return (
        db.scalar(
            select(func.count())
            .select_from(PdfRetrievalJob)
            .join(PdfRetrievalBatch, PdfRetrievalJob.batch_id == PdfRetrievalBatch.id)
            .where(*_claimable_jobs_filter(agent, utcnow()))
        )
        or 0
    )


def claim_next_job(db: Session, agent: BrowserAgent) -> PdfRetrievalJob | None:
    settings = effective_instance_settings(db)
    now = utcnow()
    query = (
        select(PdfRetrievalJob)
        .join(PdfRetrievalBatch, PdfRetrievalJob.batch_id == PdfRetrievalBatch.id)
        .where(*_claimable_jobs_filter(agent, now))
        .order_by(PdfRetrievalJob.created_at)
        .limit(25)
    )
    if db.bind is not None and db.bind.dialect.name == "postgresql":
        query = query.with_for_update(skip_locked=True)
    candidates = list(db.scalars(query))

    access_cache: dict[str, bool] = {}
    for job in candidates:
        has_access = access_cache.get(job.project_id)
        if has_access is None:
            has_access = _user_has_full_text_access(db, job.project_id, agent.user_id)
            access_cache[job.project_id] = has_access
        if not has_access:
            continue
        job.status = RetrievalJobStatus.CLAIMED
        job.claimed_by_agent_id = agent.id
        job.claimed_at = now
        job.lease_until = now + timedelta(
            seconds=settings.browser_retrieval_lease_seconds
        )
        job.attempt_count += 1
        db.flush()
        return job
    return None


def _require_agent_authorization(
    db: Session, job: PdfRetrievalJob, agent: BrowserAgent
) -> None:
    """Re-derive, from current state, that this agent may still touch this job.

    A claim is not a capability. Everything it was granted on -- the agent
    being paired, the account behind it being active, that account still
    being a project member with full-text access -- can be withdrawn while
    the browser helper is mid-retrieval, and a bearer token in an extension
    that has already claimed work would otherwise keep working indefinitely.
    So every mutable Browser Helper operation re-checks the *current* facts
    rather than trusting what was true at claim time.
    """
    if agent.revoked_at is not None:
        raise ForbiddenError("This browser helper is no longer authorized")
    if job.claimed_by_agent_id != agent.id:
        raise ForbiddenError(
            "This retrieval job is not claimed by the current browser agent"
        )
    # Covers the account being deactivated, removed from the project, or
    # having its full-text screening capability withdrawn.
    if not _user_has_full_text_access(db, job.project_id, agent.user_id):
        raise ForbiddenError(
            "Full-text retrieval access for this project is no longer granted"
        )


def require_active_claim(
    db: Session, job: PdfRetrievalJob, agent: BrowserAgent
) -> None:
    """Authorization plus a live, unexpired claim on an in-flight job.

    Used by every state/upload mutation. An expired lease is refused rather
    than silently honoured: the job is already reclaimable by another helper
    (see ``_claimable_jobs_filter``), so accepting a late write would let two
    agents fight over the same publication.
    """
    _require_agent_authorization(db, job, agent)
    if job.batch.status != BatchStatus.RUNNING:
        raise ConflictError("This retrieval batch is no longer running")
    if job.status not in IN_FLIGHT_JOB_STATUSES:
        raise ConflictError("This retrieval job is no longer in progress")
    if job.lease_until is None or _aware(job.lease_until) <= utcnow():
        raise ConflictError("The claim on this retrieval job has expired")


def release_claim(job: PdfRetrievalJob) -> bool:
    """Return an in-flight job to the queue. Returns whether it changed."""
    if job.status not in IN_FLIGHT_JOB_STATUSES:
        return False
    job.status = RetrievalJobStatus.QUEUED
    job.claimed_by_agent_id = None
    job.claimed_at = None
    job.lease_until = None
    return True


def release_claims_for_agent(db: Session, agent_ids: list[str]) -> int:
    """Requeue everything the given (now deauthorized) agents were holding."""
    if not agent_ids:
        return 0
    jobs = list(
        db.scalars(
            select(PdfRetrievalJob).where(
                PdfRetrievalJob.claimed_by_agent_id.in_(agent_ids),
                PdfRetrievalJob.status.in_(IN_FLIGHT_JOB_STATUSES),
            )
        )
    )
    released = sum(1 for job in jobs if release_claim(job))
    if released:
        db.flush()
    return released


def release_ineligible_claims(db: Session, project_id: str) -> int:
    """Requeue in-flight jobs whose claiming agent may no longer work them.

    Called from the project's central membership-change reconciliation so a
    revoked reviewer's helper stops holding work immediately, instead of the
    job sitting claimed until its lease runs out.
    """
    jobs = list(
        db.scalars(
            select(PdfRetrievalJob).where(
                PdfRetrievalJob.project_id == project_id,
                PdfRetrievalJob.status.in_(IN_FLIGHT_JOB_STATUSES),
            )
        )
    )
    access_cache: dict[str, bool] = {}
    released = 0
    for job in jobs:
        agent = (
            db.get(BrowserAgent, job.claimed_by_agent_id)
            if job.claimed_by_agent_id
            else None
        )
        if agent is not None and agent.revoked_at is None:
            has_access = access_cache.get(agent.user_id)
            if has_access is None:
                has_access = _user_has_full_text_access(db, project_id, agent.user_id)
                access_cache[agent.user_id] = has_access
            if has_access:
                continue
        if release_claim(job):
            released += 1
    if released:
        db.flush()
    return released


def get_agent_job(db: Session, agent: BrowserAgent, job_id: str) -> PdfRetrievalJob:
    """Look up a job for an agent-authenticated request.

    Only establishes *authorization*; callers that mutate in-flight state
    must additionally call :func:`require_active_claim`.
    """
    job = db.get(PdfRetrievalJob, job_id)
    if job is None:
        raise NotFoundError("Retrieval job not found")
    _require_agent_authorization(db, job, agent)
    return job


# --- State transitions -------------------------------------------------------------


def apply_job_state_update(
    db: Session,
    job: PdfRetrievalJob,
    agent: BrowserAgent,
    *,
    status: str,
    http_status: int | None,
    error_code: str | None,
    error_message: str | None,
    resolved_landing_url: str | None,
    resolved_pdf_url: str | None,
) -> PdfRetrievalJob:
    require_active_claim(db, job, agent)
    try:
        target_status = RetrievalJobStatus(status)
    except ValueError as exc:
        raise DomainError(f"Unknown retrieval job status '{status}'") from exc

    allowed = _ALLOWED_AGENT_TRANSITIONS.get(job.status, set())
    if target_status not in allowed:
        raise ConflictError(
            f"Cannot transition retrieval job from '{job.status.value}' to "
            f"'{target_status.value}'"
        )

    job.status = target_status
    if http_status is not None:
        job.http_status = http_status
    if error_code is not None:
        job.error_code = error_code[:50]
    if error_message is not None:
        job.error_message = error_message[:ERROR_MESSAGE_MAX_LENGTH]
    if resolved_landing_url is not None:
        job.resolved_landing_url = resolved_landing_url[:2000]
    if resolved_pdf_url is not None:
        job.resolved_pdf_url = resolved_pdf_url[:2000]

    if target_status in RETRYABLE_JOB_STATUSES:
        job.completed_at = utcnow()
        job.lease_until = None
        record_audit(
            db,
            action="pdf_retrieval.job_failed",
            entity_type="pdf_retrieval_job",
            entity_id=job.id,
            project_id=job.project_id,
            actor_id=agent.user_id,
            summary=f"Browser retrieval job ended as {target_status.value}",
            metadata={
                "publicationId": job.publication_id,
                "batchId": job.batch_id,
                "browserAgentId": agent.id,
                "status": target_status.value,
                "errorCode": job.error_code,
            },
        )
        _maybe_complete_batch(db, job.batch)
    db.flush()
    return job


# --- Upload ------------------------------------------------------------------------


def _finish_skipped_existing(db: Session, job: PdfRetrievalJob) -> PdfRetrievalJob:
    job.status = RetrievalJobStatus.SKIPPED_EXISTING
    job.completed_at = utcnow()
    job.lease_until = None
    retrieval = db.scalar(
        select(FullTextRetrieval).where(
            FullTextRetrieval.publication_id == job.publication_id
        )
    )
    if retrieval is not None and retrieval.status != HumanRetrievalStatus.AVAILABLE:
        # Another PDF was attached (manually or by a racing agent) while this
        # job was in flight -- the retrieval status may not have caught up
        # yet. Synchronize it rather than leaving a document orphaned from
        # the workflow it should already have entered.
        set_retrieval_status(
            db, retrieval, HumanRetrievalStatus.AVAILABLE, note=retrieval.note
        )
    _maybe_complete_batch(db, job.batch)
    db.flush()
    return job


async def upload_job_pdf(
    db: Session,
    job: PdfRetrievalJob,
    agent: BrowserAgent,
    file: UploadFile,
    *,
    source_url: str | None,
    landing_url: str | None,
) -> PdfRetrievalJob:
    try:
        require_active_claim(db, job, agent)
    except Exception:
        # Close the multipart stream before propagating, exactly as the
        # pre-existing batch/status guards below did.
        await file.close()
        raise

    if source_url:
        job.resolved_pdf_url = source_url[:2000]
    if landing_url:
        job.resolved_landing_url = landing_url[:2000]

    if active_document(db, job.publication_id) is not None:
        await file.close()
        return _finish_skipped_existing(db, job)

    job.status = RetrievalJobStatus.UPLOADING
    db.flush()

    try:
        staged = await stage_pdf_upload(
            file,
            import_batch_id=f"browser-{job.id}",
            settings=effective_instance_settings(db),
        )
    except Exception:
        db.rollback()
        raise

    try:
        document = attach_staged_pdf(
            db,
            project_id=job.project_id,
            publication_id=job.publication_id,
            staged=staged,
            user_id=agent.user_id,
            source=DocumentSource.BROWSER_RETRIEVAL,
            audit_action="pdf.retrieved_browser",
        )
    except ConflictError:
        db.rollback()
        discard_pdf(staged.storage_key)
        refreshed = db.get(PdfRetrievalJob, job.id)
        assert refreshed is not None
        return _finish_skipped_existing(db, refreshed)
    except Exception:
        db.rollback()
        discard_pdf(staged.storage_key)
        raise

    job.created_document_id = document.id
    job.status = RetrievalJobStatus.SUCCEEDED
    job.completed_at = utcnow()
    job.lease_until = None
    retrieval = db.scalar(
        select(FullTextRetrieval).where(
            FullTextRetrieval.publication_id == job.publication_id
        )
    )
    if retrieval is not None and retrieval.status != HumanRetrievalStatus.AVAILABLE:
        set_retrieval_status(
            db,
            retrieval,
            HumanRetrievalStatus.AVAILABLE,
            note=retrieval.note,
            user_id=agent.user_id,
        )
    record_audit(
        db,
        action="pdf_retrieval.job_succeeded",
        entity_type="pdf_retrieval_job",
        entity_id=job.id,
        project_id=job.project_id,
        actor_id=agent.user_id,
        summary="Browser retrieval attached a full-text PDF",
        metadata={
            "publicationId": job.publication_id,
            "documentId": document.id,
            "retrievalJobId": job.id,
            "browserAgentId": agent.id,
            "sourceUrl": job.resolved_pdf_url,
        },
    )
    _maybe_complete_batch(db, job.batch)
    db.flush()
    return job


def batch_succeeded_publication_ids(
    db: Session, batch: PdfRetrievalBatch, limit: int = 200
) -> list[str]:
    """Recently succeeded publications, so the Papertrail UI can drop a
    human retrieval card that just became stale (the browser extension
    attached a PDF for the same publication) without polling every
    publication individually."""
    return list(
        db.scalars(
            select(PdfRetrievalJob.publication_id)
            .where(
                PdfRetrievalJob.batch_id == batch.id,
                PdfRetrievalJob.status == RetrievalJobStatus.SUCCEEDED,
            )
            .order_by(PdfRetrievalJob.updated_at.desc())
            .limit(limit)
        )
    )


def job_summary_data(job: PdfRetrievalJob) -> dict[str, Any]:
    return {
        "job_id": job.id,
        "publication_id": job.publication_id,
        "title": job.publication.title if job.publication else "",
        "status": job.status.value,
        "error_code": job.error_code,
        "error_message": job.error_message,
        "resolved_landing_url": job.resolved_landing_url,
    }
