from __future__ import annotations

import enum
from datetime import datetime

from sqlalchemy import (
    Boolean,
    DateTime,
    Enum,
    Float,
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


class ReviewType(enum.StrEnum):
    SYSTEMATIC_REVIEW = "systematic_review"
    SCOPING_REVIEW = "scoping_review"
    SYSTEMATIC_MAPPING = "systematic_mapping"
    OTHER = "other"


class ProjectStage(enum.StrEnum):
    DRAFT = "draft"
    DUPLICATE_REVIEW = "duplicate_review"
    TITLE_ABSTRACT = "title_abstract_screening"
    FULL_TEXT = "full_text_screening"
    EXTRACTION = "extraction_quality"
    COMPLETED = "completed"


#: The single canonical forward order of project stages. Every module that
#: needs "is stage A before/after stage B" -- the project checklist, progress
#: displays, the screening domain's stage-completed check, the lifecycle
#: layer's move-back/reopen logic -- derives it from this tuple rather than
#: keeping a second copy that can drift out of sync with the actual workflow.
#: Lives next to the enum itself (not in app.projects.lifecycle, where the
#: rest of the lifecycle machinery lives) so every domain module can import it
#: without risking a circular import through lifecycle's own dependencies.
STAGE_ORDER: tuple[ProjectStage, ...] = (
    ProjectStage.DRAFT,
    ProjectStage.DUPLICATE_REVIEW,
    ProjectStage.TITLE_ABSTRACT,
    ProjectStage.FULL_TEXT,
    ProjectStage.EXTRACTION,
    ProjectStage.COMPLETED,
)


def stage_index(stage: ProjectStage) -> int:
    """This stage's position in :data:`STAGE_ORDER` (0 = earliest)."""
    return STAGE_ORDER.index(stage)


class CriterionKind(enum.StrEnum):
    INCLUSION = "inclusion"
    EXCLUSION = "exclusion"


class ScreeningStage(enum.StrEnum):
    TITLE_ABSTRACT = "title_abstract"
    FULL_TEXT = "full_text"


class AllocationMode(enum.StrEnum):
    INDEPENDENT = "independent"
    DIVIDED = "divided"
    CLAIM = "claim"


class TaskAllocationMode(enum.StrEnum):
    """Assignment strategy for stages with exactly one reviewer per publication
    (data extraction, quality assessment): either pre-assigned round-robin at
    creation time, or left open for reviewers to claim as they go."""

    PRE_ASSIGNED = "pre_assigned"
    CLAIM = "claim"


class ResolutionMethod(enum.StrEnum):
    DISCUSSION_CONSENSUS = "discussion_consensus"
    ADMIN_CONSENSUS = "admin_consensus"
    ADDITIONAL_REVIEWER = "additional_reviewer"
    ADJUDICATOR = "adjudicator"
    MAJORITY = "majority"


class Project(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "projects"

    name: Mapped[str] = mapped_column(String(250), nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    review_type: Mapped[ReviewType] = mapped_column(Enum(ReviewType), nullable=False)
    stage: Mapped[ProjectStage] = mapped_column(
        Enum(ProjectStage), default=ProjectStage.DRAFT, nullable=False
    )
    random_seed: Mapped[str] = mapped_column(String(128), nullable=False)
    configuration_ready: Mapped[bool] = mapped_column(
        Boolean, default=False, nullable=False
    )
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    reopened_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    #: Latest LLM run/preparation completion already reported in an "LLM
    #: processing finished" email. The next digest only reports work that
    #: finished after it, so a project never gets the same results twice.
    llm_notified_through: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True)
    )
    highlight_keywords_raw: Mapped[str] = mapped_column(
        Text, default="", server_default="", nullable=False
    )
    extraction_prompt_instructions: Mapped[str] = mapped_column(
        Text, default="", server_default="", nullable=False
    )
    title_abstract_prompt_instructions: Mapped[str] = mapped_column(
        Text, default="", server_default="", nullable=False
    )
    full_text_prompt_instructions: Mapped[str] = mapped_column(
        Text, default="", server_default="", nullable=False
    )
    validation_prompt_instructions: Mapped[str] = mapped_column(
        Text, default="", server_default="", nullable=False
    )

    memberships: Mapped[list[ProjectMembership]] = relationship(
        back_populates="project", cascade="all, delete-orphan"
    )
    research_questions: Mapped[list[ResearchQuestion]] = relationship(
        back_populates="project",
        cascade="all, delete-orphan",
        order_by="ResearchQuestion.position",
    )
    criteria: Mapped[list[Criterion]] = relationship(
        back_populates="project",
        cascade="all, delete-orphan",
        order_by="Criterion.position",
    )
    screening_configs: Mapped[list[ScreeningConfig]] = relationship(
        back_populates="project", cascade="all, delete-orphan"
    )


class ProjectMembership(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "project_memberships"
    __table_args__ = (
        UniqueConstraint("project_id", "user_id", name="uq_project_membership"),
        # Exactly one owner per project. The application enforces the "at
        # least one" half (a project is created with an owner, the owner
        # cannot be removed, and ownership only ever moves by transfer); this
        # partial index is the backstop for the "at most one" half, which no
        # amount of application care can guarantee across concurrent
        # transactions. Everything that reads ownership -- the project list's
        # owner column, is_project_manager, owner notifications -- assumes a
        # single answer.
        Index(
            "uq_project_single_owner",
            "project_id",
            unique=True,
            postgresql_where=text("is_owner = true"),
            sqlite_where=text("is_owner = 1"),
        ),
    )

    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    is_owner: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default="false", nullable=False
    )
    can_title_abstract_screen: Mapped[bool] = mapped_column(
        Boolean, default=False, nullable=False
    )
    can_full_text_screen: Mapped[bool] = mapped_column(
        Boolean, default=False, nullable=False
    )
    can_extract: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    can_assess_quality: Mapped[bool] = mapped_column(
        Boolean, default=False, nullable=False
    )
    can_adjudicate: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    workload_weight: Mapped[float] = mapped_column(
        Float, default=1.0, server_default="1", nullable=False
    )

    project: Mapped[Project] = relationship(back_populates="memberships")


class ResearchQuestion(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "research_questions"

    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
    text: Mapped[str] = mapped_column(Text, nullable=False)
    position: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    project: Mapped[Project] = relationship(back_populates="research_questions")


class Criterion(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "criteria"

    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
    kind: Mapped[CriterionKind] = mapped_column(Enum(CriterionKind), nullable=False)
    text: Mapped[str] = mapped_column(Text, nullable=False)
    position: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    project: Mapped[Project] = relationship(back_populates="criteria")


class ScreeningConfig(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "screening_configs"
    __table_args__ = (
        UniqueConstraint("project_id", "stage", name="uq_screening_config_stage"),
    )

    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
    stage: Mapped[ScreeningStage] = mapped_column(Enum(ScreeningStage), nullable=False)
    required_reviewers: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    allocation_mode: Mapped[AllocationMode] = mapped_column(
        Enum(AllocationMode), default=AllocationMode.CLAIM, nullable=False
    )
    conflict_resolution: Mapped[ResolutionMethod] = mapped_column(
        Enum(ResolutionMethod), default=ResolutionMethod.ADMIN_CONSENSUS, nullable=False
    )
    uncertain_resolution: Mapped[ResolutionMethod] = mapped_column(
        Enum(ResolutionMethod), default=ResolutionMethod.ADMIN_CONSENSUS, nullable=False
    )

    project: Mapped[Project] = relationship(back_populates="screening_configs")
