from __future__ import annotations

import enum
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, TimestampMixin, UUIDPrimaryKeyMixin


class RetrievalStatus(enum.StrEnum):
    NOT_YET_SOUGHT = "not_yet_sought"
    AVAILABLE = "available"
    REQUESTED = "requested"
    NOT_FOUND = "not_found"
    INACCESSIBLE = "inaccessible"


class FullTextRetrieval(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "full_text_retrievals"
    __table_args__ = (
        UniqueConstraint("publication_id", name="uq_full_text_retrieval_publication"),
    )

    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
    publication_id: Mapped[str] = mapped_column(
        ForeignKey("publications.id", ondelete="CASCADE"), index=True
    )
    status: Mapped[RetrievalStatus] = mapped_column(
        default=RetrievalStatus.NOT_YET_SOUGHT, index=True, nullable=False
    )
    note: Mapped[str | None] = mapped_column(String(500))
    updated_by_id: Mapped[str | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    claimed_by_id: Mapped[str | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), index=True
    )
    claimed_until: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), index=True
    )

    publication = relationship("Publication", foreign_keys=[publication_id])
