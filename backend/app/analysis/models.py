from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import DateTime, ForeignKey, Index, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, TimestampMixin, UUIDPrimaryKeyMixin
from app.db.types import JSONType


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


class ResearchQuestionAnalysisRun(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """One immutable LLM synthesis attempt for a single research question.

    Always insert-new -- never updated in place -- so full generation history
    stays available, mirroring ``LlmExtractionRun``'s immutable-run design.
    """

    __tablename__ = "research_question_analysis_runs"
    __table_args__ = (
        Index(
            "ix_rq_analysis_runs_question_created",
            "research_question_id",
            "created_at",
        ),
    )

    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
    research_question_id: Mapped[str] = mapped_column(
        ForeignKey("research_questions.id", ondelete="CASCADE"), index=True
    )
    research_question_text: Mapped[str] = mapped_column(Text, nullable=False)
    input_fingerprint: Mapped[str] = mapped_column(String(64), nullable=False)
    provider: Mapped[str] = mapped_column(String(40), default="ollama", nullable=False)
    model: Mapped[str] = mapped_column(String(250), nullable=False)
    model_configuration: Mapped[dict[str, Any] | None] = mapped_column(JSONType)
    prompt_template_version: Mapped[str] = mapped_column(String(100), nullable=False)
    status: Mapped[str] = mapped_column(String(20), index=True, nullable=False)
    result: Mapped[dict[str, Any] | None] = mapped_column(JSONType)
    validated_source_refs: Mapped[dict[str, Any] | None] = mapped_column(JSONType)
    background_job_id: Mapped[str | None] = mapped_column(
        ForeignKey("background_jobs.id", ondelete="SET NULL"), index=True
    )
    queued_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    error: Mapped[str | None] = mapped_column(Text)
