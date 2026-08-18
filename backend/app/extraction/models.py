from __future__ import annotations

import enum
from datetime import datetime
from typing import Any

from sqlalchemy import (
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, TimestampMixin, UUIDPrimaryKeyMixin
from app.db.types import JSONType
from app.projects.models import TaskAllocationMode


class ExtractionStatus(enum.StrEnum):
    AVAILABLE = "available"
    RESERVED = "reserved"
    COMPLETED = "completed"


class ExtractionConfig(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "extraction_configs"
    __table_args__ = (
        UniqueConstraint("project_id", name="uq_extraction_config_project"),
    )

    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
    allocation_mode: Mapped[TaskAllocationMode] = mapped_column(
        default=TaskAllocationMode.CLAIM, nullable=False
    )
    required_reviewers: Mapped[int] = mapped_column(
        Integer, default=1, server_default="1", nullable=False
    )


class ExtractionWorkItem(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "extraction_work_items"
    __table_args__ = (
        UniqueConstraint(
            "publication_id", "slot_number", name="uq_extraction_slot"
        ),
    )

    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
    publication_id: Mapped[str] = mapped_column(
        ForeignKey("publications.id", ondelete="CASCADE"), index=True
    )
    slot_number: Mapped[int] = mapped_column(
        Integer, default=1, server_default="1", nullable=False
    )
    assigned_reviewer_id: Mapped[str | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), index=True
    )
    reserved_until: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), index=True
    )
    random_rank: Mapped[str] = mapped_column(String(64), index=True, nullable=False)
    status: Mapped[ExtractionStatus] = mapped_column(
        default=ExtractionStatus.AVAILABLE, index=True, nullable=False
    )
    draft: Mapped[dict[str, Any]] = mapped_column(
        JSONType, default=dict, nullable=False
    )
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    responses: Mapped[list[ExtractionResponse]] = relationship(
        back_populates="work_item",
        cascade="all, delete-orphan",
        order_by="ExtractionResponse.version",
    )


class ExtractionResponse(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "extraction_responses"
    __table_args__ = (
        UniqueConstraint(
            "work_item_id", "version", name="uq_extraction_response_version"
        ),
    )

    work_item_id: Mapped[str] = mapped_column(
        ForeignKey("extraction_work_items.id", ondelete="CASCADE"), index=True
    )
    reviewer_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    form_version_id: Mapped[str] = mapped_column(
        ForeignKey("form_versions.id"), index=True
    )
    answers: Mapped[dict[str, Any]] = mapped_column(JSONType, nullable=False)
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    is_current: Mapped[bool] = mapped_column(
        Boolean, default=True, index=True, nullable=False
    )

    work_item: Mapped[ExtractionWorkItem] = relationship(back_populates="responses")


class FinalExtraction(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """The authoritative, current extraction result for a publication.

    Distinct from ExtractionResponse (an individual reviewer's immutable,
    versioned answer set): exactly zero-or-one row with is_valid=True exists
    per publication at any time, enforced both here (invalidate-then-insert
    in one transaction, see extraction/final.py) and by the partial unique
    index below as defense-in-depth. History is kept by flipping is_valid to
    False rather than deleting, mirroring app.conflicts.models.FinalDecision.
    """

    __tablename__ = "final_extractions"
    __table_args__ = (
        Index(
            "uq_final_extraction_current",
            "publication_id",
            unique=True,
            postgresql_where=text("is_valid = true"),
            sqlite_where=text("is_valid = 1"),
        ),
    )

    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
    publication_id: Mapped[str] = mapped_column(
        ForeignKey("publications.id", ondelete="CASCADE"), index=True
    )
    form_version_id: Mapped[str] = mapped_column(
        ForeignKey("form_versions.id"), index=True
    )
    answers: Mapped[dict[str, Any]] = mapped_column(JSONType, nullable=False)
    # "single_reviewer" | "agreement" | "reconciliation" | "override"
    resolution_method: Mapped[str] = mapped_column(String(80), nullable=False)
    resolved_by_id: Mapped[str | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    note: Mapped[str | None] = mapped_column(Text)
    # {stable_key: {"from": "response_a"|"response_b"|"agreed"|"manual", "responseId": str | None}}
    field_provenance: Mapped[dict[str, Any]] = mapped_column(
        JSONType, default=dict, nullable=False
    )
    contributing_response_ids: Mapped[list[str]] = mapped_column(
        JSONType, default=list, nullable=False
    )
    is_valid: Mapped[bool] = mapped_column(
        Boolean, default=True, index=True, nullable=False
    )
    invalidated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    invalidation_reason: Mapped[str | None] = mapped_column(Text)
