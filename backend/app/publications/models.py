from __future__ import annotations

import enum

from sqlalchemy import Boolean, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, TimestampMixin, UUIDPrimaryKeyMixin
from app.db.types import JSONType


class ConflictStatus(str, enum.Enum):
    OPEN = "open"
    KEEP_CURRENT = "keep_current"
    ACCEPT_PROPOSED = "accept_proposed"


class Publication(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "publications"

    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    authors: Mapped[str | None] = mapped_column(Text)
    abstract: Mapped[str | None] = mapped_column(Text)
    publication_year: Mapped[int | None] = mapped_column(Integer)
    venue: Mapped[str | None] = mapped_column(Text)
    publication_type: Mapped[str | None] = mapped_column(String(100))
    doi: Mapped[str | None] = mapped_column(String(300), index=True)
    publisher_url: Mapped[str | None] = mapped_column(Text)
    keywords: Mapped[str | None] = mapped_column(Text)
    isbn: Mapped[str | None] = mapped_column(String(100))
    issn: Mapped[str | None] = mapped_column(String(100))
    pubmed_id: Mapped[str | None] = mapped_column(String(100))
    arxiv_id: Mapped[str | None] = mapped_column(String(100))
    other_identifiers: Mapped[dict] = mapped_column(JSONType, default=dict, nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    merged_into_id: Mapped[str | None] = mapped_column(ForeignKey("publications.id", ondelete="SET NULL"), index=True)

    sources: Mapped[list[PublicationSource]] = relationship(back_populates="publication", cascade="all, delete-orphan")
    conflicts: Mapped[list[MetadataConflict]] = relationship(back_populates="publication", cascade="all, delete-orphan")


class PublicationSource(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "publication_sources"
    __table_args__ = (UniqueConstraint("imported_record_id", name="uq_publication_source_imported_record"),)

    publication_id: Mapped[str] = mapped_column(ForeignKey("publications.id", ondelete="CASCADE"), index=True)
    imported_record_id: Mapped[str] = mapped_column(ForeignKey("imported_records.id", ondelete="CASCADE"), index=True)
    publication: Mapped[Publication] = relationship(back_populates="sources")


class MetadataConflict(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "metadata_conflicts"

    publication_id: Mapped[str] = mapped_column(ForeignKey("publications.id", ondelete="CASCADE"), index=True)
    field_name: Mapped[str] = mapped_column(String(100), nullable=False)
    current_value: Mapped[str | None] = mapped_column(Text)
    proposed_value: Mapped[str | None] = mapped_column(Text)
    source_name: Mapped[str] = mapped_column(String(100), nullable=False)
    status: Mapped[str] = mapped_column(String(30), default="open", nullable=False)
    publication: Mapped[Publication] = relationship(back_populates="conflicts")
