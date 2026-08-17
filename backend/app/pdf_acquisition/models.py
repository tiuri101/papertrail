from __future__ import annotations

import enum
from datetime import datetime

from sqlalchemy import (
    DateTime,
    Enum,
    ForeignKey,
    Index,
    Integer,
    String,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, TimestampMixin, UUIDPrimaryKeyMixin


class BrowserAgent(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """A paired Chrome extension instance. Authenticates with its own bearer
    token (see token_hash) -- entirely separate from the session-cookie/CSRF
    mechanism used by the Papertrail web UI."""

    __tablename__ = "browser_agents"

    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    display_name: Mapped[str] = mapped_column(String(200), nullable=False)
    token_hash: Mapped[str] = mapped_column(
        String(64), unique=True, index=True, nullable=False
    )
    extension_version: Mapped[str | None] = mapped_column(String(50))
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), index=True
    )

    user = relationship("User")


class BrowserAgentPairing(UUIDPrimaryKeyMixin, Base):
    """A single-use, time-limited secret used to mint a BrowserAgent. Never
    stored in plaintext; the raw secret is shown to the user exactly once."""

    __tablename__ = "browser_agent_pairings"

    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    token_hash: Mapped[str] = mapped_column(
        String(64), unique=True, index=True, nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    expires_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), index=True, nullable=False
    )
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    user = relationship("User")


class BatchStatus(enum.StrEnum):
    RUNNING = "running"
    COMPLETED = "completed"
    CANCELLED = "cancelled"


class PdfRetrievalBatch(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """One 'retrieve missing PDFs' run for a project. Owned by the user who
    started it; job counts are derived from PdfRetrievalJob rather than
    cached here, so they can never drift."""

    __tablename__ = "pdf_retrieval_batches"

    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
    created_by_user_id: Mapped[str | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    status: Mapped[BatchStatus] = mapped_column(
        Enum(BatchStatus), default=BatchStatus.RUNNING, index=True, nullable=False
    )
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    cancelled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    jobs: Mapped[list[PdfRetrievalJob]] = relationship(
        back_populates="batch", cascade="all, delete-orphan"
    )
    created_by = relationship("User", foreign_keys=[created_by_user_id])


class RetrievalJobStatus(enum.StrEnum):
    QUEUED = "queued"
    CLAIMED = "claimed"
    RETRIEVING = "retrieving"
    UPLOADING = "uploading"

    SUCCEEDED = "succeeded"
    NEEDS_AUTHENTICATION = "needs_authentication"
    NOT_FOUND = "not_found"
    ACCESS_DENIED = "access_denied"
    INVALID_RESPONSE = "invalid_response"
    FAILED = "failed"
    CANCELLED = "cancelled"
    SKIPPED_EXISTING = "skipped_existing"


# Central definitions so routes/services never need to duplicate these lists.
ACTIVE_JOB_STATUSES = frozenset(
    {
        RetrievalJobStatus.QUEUED,
        RetrievalJobStatus.CLAIMED,
        RetrievalJobStatus.RETRIEVING,
        RetrievalJobStatus.UPLOADING,
    }
)

TERMINAL_JOB_STATUSES = frozenset(
    {
        RetrievalJobStatus.SUCCEEDED,
        RetrievalJobStatus.NEEDS_AUTHENTICATION,
        RetrievalJobStatus.NOT_FOUND,
        RetrievalJobStatus.ACCESS_DENIED,
        RetrievalJobStatus.INVALID_RESPONSE,
        RetrievalJobStatus.FAILED,
        RetrievalJobStatus.CANCELLED,
        RetrievalJobStatus.SKIPPED_EXISTING,
    }
)

# Failure outcomes that a human retry (after e.g. logging in, or once the
# publisher is reachable again) has a real chance of succeeding at.
RETRYABLE_JOB_STATUSES = frozenset(
    {
        RetrievalJobStatus.NEEDS_AUTHENTICATION,
        RetrievalJobStatus.ACCESS_DENIED,
        RetrievalJobStatus.NOT_FOUND,
        RetrievalJobStatus.INVALID_RESPONSE,
        RetrievalJobStatus.FAILED,
    }
)

# Automated outcomes that must NEVER be translated into a human-authoritative
# FullTextRetrieval terminal status -- an automated failure does not prove a
# human can't obtain the paper by other means.
NON_AUTHORITATIVE_FAILURE_STATUSES = RETRYABLE_JOB_STATUSES


class PdfRetrievalJob(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """One publication's browser-retrieval attempt within a batch. A
    publication may appear in jobs across multiple historical batches, but at
    most once within a single batch (uq_pdf_retrieval_job_batch_publication).
    """

    __tablename__ = "pdf_retrieval_jobs"
    __table_args__ = (
        UniqueConstraint(
            "batch_id", "publication_id", name="uq_pdf_retrieval_job_batch_publication"
        ),
        Index("ix_pdf_retrieval_jobs_status_lease", "status", "lease_until"),
        Index("ix_pdf_retrieval_jobs_project_status", "project_id", "status"),
    )

    batch_id: Mapped[str] = mapped_column(
        ForeignKey("pdf_retrieval_batches.id", ondelete="CASCADE"), index=True
    )
    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
    publication_id: Mapped[str] = mapped_column(
        ForeignKey("publications.id", ondelete="CASCADE"), index=True
    )

    status: Mapped[RetrievalJobStatus] = mapped_column(
        Enum(RetrievalJobStatus),
        default=RetrievalJobStatus.QUEUED,
        index=True,
        nullable=False,
    )

    claimed_by_agent_id: Mapped[str | None] = mapped_column(
        ForeignKey("browser_agents.id", ondelete="SET NULL"), index=True
    )
    claimed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    lease_until: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), index=True
    )

    attempt_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    resolved_landing_url: Mapped[str | None] = mapped_column(String(2000))
    resolved_pdf_url: Mapped[str | None] = mapped_column(String(2000))

    http_status: Mapped[int | None] = mapped_column(Integer)
    error_code: Mapped[str | None] = mapped_column(String(50))
    error_message: Mapped[str | None] = mapped_column(String(500))

    created_document_id: Mapped[str | None] = mapped_column(
        ForeignKey("publication_documents.id", ondelete="SET NULL")
    )

    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    batch: Mapped[PdfRetrievalBatch] = relationship(back_populates="jobs")
    publication = relationship("Publication")
    claimed_by_agent = relationship("BrowserAgent")
