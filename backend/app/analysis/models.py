from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, TimestampMixin, UUIDPrimaryKeyMixin


class StageAnalysis(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "stage_analyses"
    __table_args__ = (
        UniqueConstraint("project_id", "stage", name="uq_stage_analysis_project_stage"),
    )

    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
    stage: Mapped[str] = mapped_column(String(40), index=True, nullable=False)
    summary: Mapped[str] = mapped_column(Text, nullable=False)
    stats_fingerprint: Mapped[str] = mapped_column(String(64), nullable=False)
    generated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
