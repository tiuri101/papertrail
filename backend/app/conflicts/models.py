from __future__ import annotations

from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Index, String, Text, text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, TimestampMixin, UUIDPrimaryKeyMixin
from app.projects.models import ScreeningStage
from app.screening.models import ScreeningOutcome


class FinalDecision(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """The authoritative screening verdict for one publication at one stage.

    At most one row with ``is_valid=True`` exists per (publication, stage) at
    any time: superseded verdicts are kept as history by flipping ``is_valid``
    to False rather than being deleted. That is enforced primarily by
    serializing finalization on the publication row (see
    ``app.review_work.finalization``) and by the invalidate-then-insert write
    path in ``app.conflicts.service.record_final_decision``; the partial
    unique index below is defense-in-depth, mirroring
    ``app.extraction.models.FinalExtraction``.
    """

    __tablename__ = "final_decisions"
    __table_args__ = (
        Index(
            "uq_final_decision_current",
            "publication_id",
            "stage",
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
    stage: Mapped[ScreeningStage] = mapped_column(index=True, nullable=False)
    outcome: Mapped[ScreeningOutcome] = mapped_column(index=True, nullable=False)
    resolution_method: Mapped[str] = mapped_column(String(80), nullable=False)
    resolved_by_id: Mapped[str | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    note: Mapped[str | None] = mapped_column(Text)
    is_valid: Mapped[bool] = mapped_column(
        Boolean, default=True, index=True, nullable=False
    )
    invalidated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    invalidation_reason: Mapped[str | None] = mapped_column(Text)
