from __future__ import annotations

import enum

from sqlalchemy import ForeignKey, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, TimestampMixin, UUIDPrimaryKeyMixin


class RetrievalStatus(str, enum.Enum):
    NOT_YET_SOUGHT = "not_yet_sought"
    AVAILABLE = "available"
    REQUESTED = "requested"
    NOT_FOUND = "not_found"
    INACCESSIBLE = "inaccessible"


class FullTextRetrieval(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "full_text_retrievals"
    __table_args__ = (UniqueConstraint("publication_id", name="uq_full_text_retrieval_publication"),)

    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    publication_id: Mapped[str] = mapped_column(ForeignKey("publications.id", ondelete="CASCADE"), index=True)
    status: Mapped[RetrievalStatus] = mapped_column(default=RetrievalStatus.NOT_YET_SOUGHT, index=True, nullable=False)
    note: Mapped[str | None] = mapped_column(String(500))
    updated_by_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
