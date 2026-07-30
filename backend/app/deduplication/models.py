from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, Float, ForeignKey, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, TimestampMixin, UUIDPrimaryKeyMixin
from app.db.types import JSONType


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
    match_reasons: Mapped[list] = mapped_column(JSONType, default=list, nullable=False)
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

    publication_a = relationship("Publication", foreign_keys=[publication_a_id])
    publication_b = relationship("Publication", foreign_keys=[publication_b_id])


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
    canonical_before: Mapped[dict] = mapped_column(JSONType, nullable=False)
    merged_before: Mapped[dict] = mapped_column(JSONType, nullable=False)
    moved_source_ids: Mapped[list] = mapped_column(JSONType, nullable=False)
    reversed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    reversed_by_id: Mapped[str | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
