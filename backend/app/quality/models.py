from __future__ import annotations

import enum
from datetime import datetime
from typing import Any

from sqlalchemy import (
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, TimestampMixin, UUIDPrimaryKeyMixin
from app.db.types import JSONType


class QualityStatus(enum.StrEnum):
    AVAILABLE = "available"
    RESERVED = "reserved"
    COMPLETED = "completed"


class QualityConfig(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "quality_configs"
    __table_args__ = (UniqueConstraint("project_id", name="uq_quality_config_project"),)

    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    mode: Mapped[str] = mapped_column(String(30), default="both", nullable=False)
    aggregation: Mapped[str] = mapped_column(String(30), default="sum", nullable=False)


class QualityWorkItem(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "quality_work_items"
    __table_args__ = (
        UniqueConstraint("publication_id", name="uq_quality_publication"),
    )

    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
    publication_id: Mapped[str] = mapped_column(
        ForeignKey("publications.id", ondelete="CASCADE"), index=True
    )
    assigned_reviewer_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    reserved_until: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), index=True
    )
    random_rank: Mapped[str] = mapped_column(String(64), index=True, nullable=False)
    status: Mapped[QualityStatus] = mapped_column(
        default=QualityStatus.AVAILABLE, index=True, nullable=False
    )
    draft: Mapped[dict[str, Any]] = mapped_column(
        JSONType, default=dict, nullable=False
    )
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    responses: Mapped[list[QualityResponse]] = relationship(
        back_populates="work_item",
        cascade="all, delete-orphan",
        order_by="QualityResponse.version",
    )


class QualityResponse(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "quality_responses"
    __table_args__ = (
        UniqueConstraint("work_item_id", "version", name="uq_quality_response_version"),
    )

    work_item_id: Mapped[str] = mapped_column(
        ForeignKey("quality_work_items.id", ondelete="CASCADE"), index=True
    )
    reviewer_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    form_version_id: Mapped[str] = mapped_column(
        ForeignKey("form_versions.id"), index=True
    )
    answers: Mapped[dict[str, Any]] = mapped_column(JSONType, nullable=False)
    total_score: Mapped[float | None] = mapped_column(Float)
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    is_current: Mapped[bool] = mapped_column(
        Boolean, default=True, index=True, nullable=False
    )

    work_item: Mapped[QualityWorkItem] = relationship(back_populates="responses")
