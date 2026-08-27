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
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, TimestampMixin, UUIDPrimaryKeyMixin
from app.db.types import JSONType
from app.projects.models import ScreeningStage


class ScreeningOutcome(enum.StrEnum):
    INCLUDE = "include"
    EXCLUDE = "exclude"
    UNCERTAIN = "uncertain"
    DUPLICATE = "duplicate"


class WorkItemStatus(enum.StrEnum):
    AVAILABLE = "available"
    RESERVED = "reserved"
    SUBMITTED = "submitted"


class ScreeningWorkItem(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "screening_work_items"
    __table_args__ = (
        UniqueConstraint(
            "publication_id", "stage", "slot_number", name="uq_screening_slot"
        ),
        # Supports the reviewer-queue claim query in claim_next_work_item and the
        # ineligible-assignment probe in reassign_work_items_from_ineligible_reviewers:
        # both filter by project + stage + status (+ assignee) and order by
        # random_rank. Without this the planner falls back to combining several
        # single-column indexes plus an in-memory sort over every row in the stage.
        Index(
            "ix_screening_wi_queue",
            "project_id",
            "stage",
            "status",
            "assigned_reviewer_id",
            "random_rank",
        ),
        # Rank-ordered scans that don't constrain status (rebalance, orphan
        # redistribution).
        Index("ix_screening_wi_rank", "project_id", "stage", "random_rank"),
    )

    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
    publication_id: Mapped[str] = mapped_column(
        ForeignKey("publications.id", ondelete="CASCADE"), index=True
    )
    stage: Mapped[ScreeningStage] = mapped_column(nullable=False, index=True)
    slot_number: Mapped[int] = mapped_column(Integer, nullable=False)
    assigned_reviewer_id: Mapped[str | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), index=True
    )
    reserved_by_id: Mapped[str | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), index=True
    )
    reserved_until: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), index=True
    )
    random_rank: Mapped[str] = mapped_column(String(64), index=True, nullable=False)
    status: Mapped[WorkItemStatus] = mapped_column(
        default=WorkItemStatus.AVAILABLE, index=True, nullable=False
    )
    draft: Mapped[dict[str, Any]] = mapped_column(
        JSONType, default=dict, nullable=False
    )
    submitted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # True only for a conflict-resolution "additional reviewer" slot created
    # by add_resolution_reviewer, never for one of the originally-configured
    # required_reviewers slots. ScreeningConfig.required_reviewers can change
    # over a project's life with no snapshot of what it was at creation time,
    # so this flag -- not slot_number vs. the current config value -- is the
    # reliable way to tell original decisions apart from tie-break ones for
    # reviewer-agreement analysis.
    is_additional_slot: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default="false", nullable=False
    )

    decisions: Mapped[list[ScreeningDecision]] = relationship(
        back_populates="work_item",
        cascade="all, delete-orphan",
        order_by="ScreeningDecision.version",
    )


class ScreeningDecision(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "screening_decisions"
    __table_args__ = (
        UniqueConstraint(
            "work_item_id", "version", name="uq_screening_decision_version"
        ),
        # decisions_visible / current_decisions repeatedly ask for the current
        # decision of a work item; this covers that lookup directly.
        Index("ix_screening_decision_current", "work_item_id", "is_current"),
    )

    work_item_id: Mapped[str] = mapped_column(
        ForeignKey("screening_work_items.id", ondelete="CASCADE"), index=True
    )
    reviewer_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    outcome: Mapped[ScreeningOutcome] = mapped_column(nullable=False, index=True)
    criteria_answers: Mapped[dict[str, Any]] = mapped_column(JSONType, nullable=False)
    notes: Mapped[str | None] = mapped_column(Text)
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    is_current: Mapped[bool] = mapped_column(
        Boolean, default=True, index=True, nullable=False
    )

    work_item: Mapped[ScreeningWorkItem] = relationship(back_populates="decisions")
    reviewer = relationship("User", foreign_keys=[reviewer_id])
