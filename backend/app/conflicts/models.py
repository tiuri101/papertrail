from __future__ import annotations

from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, TimestampMixin, UUIDPrimaryKeyMixin
from app.projects.models import ScreeningStage
from app.screening.models import ScreeningOutcome


class FinalDecision(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "final_decisions"

    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    publication_id: Mapped[str] = mapped_column(ForeignKey("publications.id", ondelete="CASCADE"), index=True)
    stage: Mapped[ScreeningStage] = mapped_column(index=True, nullable=False)
    outcome: Mapped[ScreeningOutcome] = mapped_column(index=True, nullable=False)
    resolution_method: Mapped[str] = mapped_column(String(80), nullable=False)
    resolved_by_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    note: Mapped[str | None] = mapped_column(Text)
    is_valid: Mapped[bool] = mapped_column(Boolean, default=True, index=True, nullable=False)
    invalidated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    invalidation_reason: Mapped[str | None] = mapped_column(Text)
