from __future__ import annotations

import enum
from typing import TYPE_CHECKING, Any

from sqlalchemy import Boolean, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, TimestampMixin, UUIDPrimaryKeyMixin
from app.db.types import JSONType

if TYPE_CHECKING:
    from app.conflicts.models import FinalDecision
    from app.extraction.models import ExtractionWorkItem
    from app.fulltext.models import FullTextRetrieval, PublicationDocument
    from app.imports.models import ImportedRecord


class ConflictStatus(enum.StrEnum):
    OPEN = "open"
    KEEP_CURRENT = "keep_current"
    ACCEPT_PROPOSED = "accept_proposed"


class Publication(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "publications"

    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
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
    other_identifiers: Mapped[dict[str, Any]] = mapped_column(
        JSONType, default=dict, nullable=False
    )
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    merged_into_id: Mapped[str | None] = mapped_column(
        ForeignKey("publications.id", ondelete="SET NULL"), index=True
    )

    sources: Mapped[list[PublicationSource]] = relationship(
        back_populates="publication", cascade="all, delete-orphan"
    )
    conflicts: Mapped[list[MetadataConflict]] = relationship(
        back_populates="publication", cascade="all, delete-orphan"
    )
    documents: Mapped[list[PublicationDocument]] = relationship(
        back_populates="publication", cascade="all, delete-orphan"
    )
    final_decisions: Mapped[list[FinalDecision]] = relationship(viewonly=True)
    extraction_work_item: Mapped[ExtractionWorkItem | None] = relationship(
        viewonly=True, uselist=False
    )
    full_text_retrieval: Mapped[FullTextRetrieval | None] = relationship(
        viewonly=True, uselist=False
    )

    @property
    def active_document(self) -> PublicationDocument | None:
        return next(
            (document for document in self.documents if document.is_active), None
        )

    @property
    def full_text(self) -> dict[str, object]:
        document = self.active_document
        retrieval = self.full_text_retrieval
        return {
            "available": document is not None,
            "document": document,
            "retrieval_status": str(retrieval.status) if retrieval else None,
        }

    @property
    def screening_status(self) -> dict[str, str | None]:
        """The current, valid final decision for each screening stage this
        publication has reached (None if that stage hasn't produced one yet,
        e.g. it's still awaiting review or hasn't advanced to full text)."""
        status: dict[str, str | None] = {"title_abstract": None, "full_text": None}
        for decision in self.final_decisions:
            if not decision.is_valid:
                continue
            key = str(decision.stage)
            if key in status and status[key] is None:
                status[key] = str(decision.outcome)
        return status

    @property
    def extraction_status(self) -> str | None:
        return (
            str(self.extraction_work_item.status)
            if self.extraction_work_item is not None
            else None
        )

    @property
    def search_sources(self) -> list[dict[str, Any]]:
        """The search imports (and, transitively, searches) that brought in
        this publication. A publication can trace back to more than one
        when a duplicate merge combines records pulled in separately."""
        seen: set[str] = set()
        results: list[dict[str, Any]] = []
        for source in self.sources:
            record = source.imported_record
            batch = record.import_batch if record else None
            if batch is None or batch.id in seen:
                continue
            seen.add(batch.id)
            results.append(
                {
                    "import_batch_id": batch.id,
                    "original_filename": batch.original_filename,
                    "search_source_id": batch.search_source_id,
                    "source_name": (
                        batch.search_source.source_name if batch.search_source else None
                    ),
                }
            )
        return results


class PublicationSource(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "publication_sources"
    __table_args__ = (
        UniqueConstraint(
            "imported_record_id", name="uq_publication_source_imported_record"
        ),
    )

    publication_id: Mapped[str] = mapped_column(
        ForeignKey("publications.id", ondelete="CASCADE"), index=True
    )
    imported_record_id: Mapped[str] = mapped_column(
        ForeignKey("imported_records.id", ondelete="CASCADE"), index=True
    )
    publication: Mapped[Publication] = relationship(back_populates="sources")
    imported_record: Mapped[ImportedRecord] = relationship()


class MetadataConflict(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "metadata_conflicts"

    publication_id: Mapped[str] = mapped_column(
        ForeignKey("publications.id", ondelete="CASCADE"), index=True
    )
    field_name: Mapped[str] = mapped_column(String(100), nullable=False)
    current_value: Mapped[str | None] = mapped_column(Text)
    proposed_value: Mapped[str | None] = mapped_column(Text)
    source_name: Mapped[str] = mapped_column(String(100), nullable=False)
    status: Mapped[str] = mapped_column(String(30), default="open", nullable=False)
    publication: Mapped[Publication] = relationship(back_populates="conflicts")
