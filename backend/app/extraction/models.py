from __future__ import annotations

import enum
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, TimestampMixin, UUIDPrimaryKeyMixin
from app.db.types import JSONType


class ExtractionStatus(str, enum.Enum):
    AVAILABLE = "available"
    RESERVED = "reserved"
    COMPLETED = "completed"


class ExtractionWorkItem(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "extraction_work_items"
    __table_args__ = (UniqueConstraint("publication_id", name="uq_extraction_publication"),)

    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    publication_id: Mapped[str] = mapped_column(ForeignKey("publications.id", ondelete="CASCADE"), index=True)
    assigned_reviewer_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    reserved_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)
    random_rank: Mapped[str] = mapped_column(String(64), index=True, nullable=False)
    status: Mapped[ExtractionStatus] = mapped_column(default=ExtractionStatus.AVAILABLE, index=True, nullable=False)
    draft: Mapped[dict] = mapped_column(JSONType, default=dict, nullable=False)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    responses: Mapped[list[ExtractionResponse]] = relationship(back_populates="work_item", cascade="all, delete-orphan", order_by="ExtractionResponse.version")


class ExtractionResponse(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "extraction_responses"
    __table_args__ = (UniqueConstraint("work_item_id", "version", name="uq_extraction_response_version"),)

    work_item_id: Mapped[str] = mapped_column(ForeignKey("extraction_work_items.id", ondelete="CASCADE"), index=True)
    reviewer_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    form_version_id: Mapped[str] = mapped_column(ForeignKey("form_versions.id"), index=True)
    answers: Mapped[dict] = mapped_column(JSONType, nullable=False)
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    is_current: Mapped[bool] = mapped_column(Boolean, default=True, index=True, nullable=False)

    work_item: Mapped[ExtractionWorkItem] = relationship(back_populates="responses")
