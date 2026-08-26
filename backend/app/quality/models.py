from __future__ import annotations

import enum
from datetime import datetime
from typing import Any

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    Enum,
    Float,
    ForeignKey,
    Integer,
    String,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, TimestampMixin, UUIDPrimaryKeyMixin
from app.db.types import JSONType
from app.projects.models import TaskAllocationMode


class QualityStatus(enum.StrEnum):
    AVAILABLE = "available"
    RESERVED = "reserved"
    COMPLETED = "completed"


class QualityMode(enum.StrEnum):
    """What a project's quality assessment produces.

    ``QUALITATIVE`` records the reviewer's answers only; ``NUMERIC`` and
    ``BOTH`` additionally compute and store a ``total_score`` per response.
    """

    QUALITATIVE = "qualitative"
    NUMERIC = "numeric"
    BOTH = "both"


class QualityAggregation(enum.StrEnum):
    """How per-field scores combine into a response's ``total_score``.

    Closed on purpose: an unrecognized value used to fall through to
    ``SUM``, so a typo produced plausible-looking but wrong scores instead
    of an error.
    """

    SUM = "sum"
    AVERAGE = "average"
    WEIGHTED_AVERAGE = "weighted_average"


def _enum_values(enum_class: type[enum.Enum]) -> list[str]:
    return [str(member.value) for member in enum_class]


# Stored as their lowercase values in a plain VARCHAR (not a PostgreSQL
# native enum), matching the columns these two replaced; the enum type is
# what makes an unrecognized value fail loudly on read and write instead of
# silently selecting a default.
#
# ``create_constraint=False`` with an explicit CheckConstraint below rather
# than SQLAlchemy's built-in one: a type-bound constraint is invisible to
# Alembic's metadata comparison but *is* reflected from the database, so every
# future autogenerate run would propose dropping it. Declared by hand, it
# round-trips.
def _quality_enum(enum_class: type[enum.Enum], name: str) -> Enum:
    return Enum(
        enum_class,
        name=name,
        native_enum=False,
        length=30,
        create_constraint=False,
        values_callable=_enum_values,
    )


def _value_check(column: str, enum_class: type[enum.Enum], name: str) -> CheckConstraint:
    allowed = ", ".join(f"'{value}'" for value in _enum_values(enum_class))
    return CheckConstraint(f"{column} IN ({allowed})", name=name)


class QualityConfig(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "quality_configs"
    __table_args__ = (
        UniqueConstraint("project_id", name="uq_quality_config_project"),
        _value_check("mode", QualityMode, "qualitymode"),
        _value_check("aggregation", QualityAggregation, "qualityaggregation"),
    )

    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    mode: Mapped[QualityMode] = mapped_column(
        _quality_enum(QualityMode, "qualitymode"),
        default=QualityMode.BOTH,
        nullable=False,
    )
    aggregation: Mapped[QualityAggregation] = mapped_column(
        _quality_enum(QualityAggregation, "qualityaggregation"),
        default=QualityAggregation.SUM,
        nullable=False,
    )
    allocation_mode: Mapped[TaskAllocationMode] = mapped_column(
        default=TaskAllocationMode.CLAIM, nullable=False
    )


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
    assigned_reviewer_id: Mapped[str | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), index=True
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
