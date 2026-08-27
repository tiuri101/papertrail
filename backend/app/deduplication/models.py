from __future__ import annotations

from datetime import datetime
from typing import Any, TypedDict

from sqlalchemy import (
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, TimestampMixin, UUIDPrimaryKeyMixin
from app.db.types import JSONType


class MovedDocumentState(TypedDict):
    id: str
    is_active: bool
    replaced_by_document_id: str | None


class DuplicateCandidate(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "duplicate_candidates"
    __table_args__ = (
        UniqueConstraint(
            "project_id",
            "publication_a_id",
            "publication_b_id",
            name="uq_duplicate_pair",
        ),
    )

    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
    publication_a_id: Mapped[str] = mapped_column(
        ForeignKey("publications.id", ondelete="CASCADE"), index=True
    )
    publication_b_id: Mapped[str] = mapped_column(
        ForeignKey("publications.id", ondelete="CASCADE"), index=True
    )
    match_reasons: Mapped[list[str]] = mapped_column(
        JSONType, default=list, nullable=False
    )
    title_similarity: Mapped[float | None] = mapped_column(Float)
    author_similarity: Mapped[float | None] = mapped_column(Float)
    year_agreement: Mapped[bool | None]
    confidence: Mapped[float] = mapped_column(Float, nullable=False)
    status: Mapped[str] = mapped_column(
        String(30), default="unresolved", index=True, nullable=False
    )
    resolved_by_id: Mapped[str | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    resolution_note: Mapped[str | None] = mapped_column(Text)
    # External-provider (Crossref / Semantic Scholar) assessment of a pair that
    # ``detect_duplicates`` could not auto-merge, written by the
    # ``assess_duplicate_candidates`` job. A provider-confirmed same-work match
    # is auto-merged and never lands here; everything else stays a *hint* the
    # review UI shows next to the reviewer's own buttons -- a reviewer still
    # makes the call. ``provider_recommendation`` is one of "merge" (keep
    # ``provider_recommended_canonical_id``), "distinct", or "uncertain".
    provider_recommendation: Mapped[str | None] = mapped_column(String(20))
    provider_recommended_canonical_id: Mapped[str | None] = mapped_column(
        ForeignKey(
            "publications.id",
            ondelete="SET NULL",
            name="fk_dup_candidate_provider_canonical",
        )
    )
    provider_recommendation_reason: Mapped[str | None] = mapped_column(Text)
    #: "crossref", "semantic_scholar", or "url_reachability".
    provider_recommendation_source: Mapped[str | None] = mapped_column(String(50))
    provider_assessed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True)
    )
    auto_resolved: Mapped[bool] = mapped_column(
        Boolean, server_default="false", default=False, nullable=False
    )
    # Soft reservation lease, mirroring the reviewer queues in screening /
    # extraction / quality: an unresolved candidate handed to one reviewer via
    # ``claim_next_duplicate`` is hidden from the others until the lease
    # expires. The candidate row *is* the work item (one pair, one reviewer),
    # so there is no separate work-item table.
    reserved_by_id: Mapped[str | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    reserved_until: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), index=True
    )

    publication_a = relationship("Publication", foreign_keys=[publication_a_id])
    publication_b = relationship("Publication", foreign_keys=[publication_b_id])
    resolved_by = relationship("User", foreign_keys=[resolved_by_id])


class PublicationMerge(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "publication_merges"

    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
    canonical_publication_id: Mapped[str] = mapped_column(
        ForeignKey("publications.id", ondelete="CASCADE"), index=True
    )
    merged_publication_id: Mapped[str] = mapped_column(
        ForeignKey("publications.id", ondelete="CASCADE"), index=True
    )
    candidate_id: Mapped[str | None] = mapped_column(
        ForeignKey("duplicate_candidates.id", ondelete="SET NULL")
    )
    merged_by_id: Mapped[str | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    canonical_before: Mapped[dict[str, Any]] = mapped_column(JSONType, nullable=False)
    merged_before: Mapped[dict[str, Any]] = mapped_column(JSONType, nullable=False)
    moved_source_ids: Mapped[list[str]] = mapped_column(JSONType, nullable=False)
    moved_document_states: Mapped[list[MovedDocumentState]] = mapped_column(
        JSONType, default=list, nullable=False
    )
    reversed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    reversed_by_id: Mapped[str | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )


class PublicationUrlCheck(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """The result of probing one bibliographic URL on a publication that is
    part of an unresolved duplicate candidate. Written by the
    ``assess_duplicate_candidates`` job; a dead link on one record is a signal
    for keeping the other. Ephemeral status data, not review history: the job
    upserts one current row per (publication, kind).
    """

    __tablename__ = "publication_url_checks"
    __table_args__ = (
        UniqueConstraint(
            "publication_id", "url_kind", name="uq_url_check_kind"
        ),
    )

    publication_id: Mapped[str] = mapped_column(
        ForeignKey("publications.id", ondelete="CASCADE"), index=True
    )
    #: "publisher_url" or "doi".
    url_kind: Mapped[str] = mapped_column(String(20), nullable=False)
    url: Mapped[str] = mapped_column(Text, nullable=False)
    #: True/False once the probe reached a verdict; None when it errored before
    #: one (timeout, DNS failure, TLS error).
    reachable: Mapped[bool | None] = mapped_column(Boolean)
    status_code: Mapped[int | None] = mapped_column(Integer)
    error: Mapped[str | None] = mapped_column(Text)
    checked_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
