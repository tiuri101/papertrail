from __future__ import annotations

import enum
from uuid import uuid4

from sqlalchemy import Boolean, Enum, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, TimestampMixin, UUIDPrimaryKeyMixin
from app.db.types import JSONType


class FormKind(str, enum.Enum):
    EXTRACTION = "extraction"
    QUALITY = "quality"


class FieldType(str, enum.Enum):
    SHORT_TEXT = "short_text"
    LONG_TEXT = "long_text"
    NUMBER = "number"
    CHECKBOX = "checkbox"
    SINGLE_SELECT = "single_select"
    MULTIPLE_SELECT = "multiple_select"
    DATE = "date"
    URL = "url"
    RATING = "rating"


class ReviewForm(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "review_forms"

    project_id: Mapped[str | None] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(250), nullable=False)
    kind: Mapped[FormKind] = mapped_column(Enum(FormKind), index=True, nullable=False)
    is_template: Mapped[bool] = mapped_column(Boolean, default=False, index=True, nullable=False)
    active_version_id: Mapped[str | None] = mapped_column(String(36), index=True)

    versions: Mapped[list[FormVersion]] = relationship(back_populates="form", cascade="all, delete-orphan")


class FormVersion(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "form_versions"
    __table_args__ = (UniqueConstraint("form_id", "version_number", name="uq_form_version_number"),)

    form_id: Mapped[str] = mapped_column(ForeignKey("review_forms.id", ondelete="CASCADE"), index=True)
    version_number: Mapped[int] = mapped_column(Integer, nullable=False)
    change_summary: Mapped[str | None] = mapped_column(String(500))
    is_published: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    form: Mapped[ReviewForm] = relationship(back_populates="versions")
    fields: Mapped[list[FormField]] = relationship(
        back_populates="version", cascade="all, delete-orphan", order_by="FormField.position"
    )


class FormField(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "form_fields"
    __table_args__ = (UniqueConstraint("form_version_id", "stable_key", name="uq_form_field_stable_key"),)

    form_version_id: Mapped[str] = mapped_column(ForeignKey("form_versions.id", ondelete="CASCADE"), index=True)
    stable_key: Mapped[str] = mapped_column(String(36), default=lambda: str(uuid4()), index=True, nullable=False)
    label: Mapped[str] = mapped_column(String(300), nullable=False)
    field_type: Mapped[FieldType] = mapped_column(Enum(FieldType), nullable=False)
    required: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    position: Mapped[int] = mapped_column(Integer, nullable=False)
    options: Mapped[list] = mapped_column(JSONType, default=list, nullable=False)
    scoring: Mapped[dict] = mapped_column(JSONType, default=dict, nullable=False)
    is_archived: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    version: Mapped[FormVersion] = relationship(back_populates="fields")
