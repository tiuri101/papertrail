from __future__ import annotations

import enum
from datetime import date, datetime

from sqlalchemy import Date, DateTime, Enum, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, TimestampMixin, UUIDPrimaryKeyMixin
from app.db.types import JSONType


class ImportStatus(enum.StrEnum):
    PENDING = "pending"
    PROCESSING = "processing"
    COMPLETED = "completed"
    FAILED = "failed"


class SearchSource(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "search_sources"

    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
    source_name: Mapped[str] = mapped_column(String(200), nullable=False)
    query: Mapped[str] = mapped_column(Text, nullable=False)
    search_date: Mapped[date] = mapped_column(Date, nullable=False)
    filters: Mapped[str | None] = mapped_column(Text)
    exported_result_count: Mapped[int] = mapped_column(
        Integer, default=0, nullable=False
    )
    created_by_id: Mapped[str] = mapped_column(ForeignKey("users.id"), nullable=False)

    import_batches: Mapped[list[ImportBatch]] = relationship(
        back_populates="search_source"
    )


class ImportBatch(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "import_batches"

    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
    search_source_id: Mapped[str | None] = mapped_column(
        ForeignKey("search_sources.id", ondelete="SET NULL"), index=True
    )
    original_filename: Mapped[str] = mapped_column(String(500), nullable=False)
    stored_path: Mapped[str] = mapped_column(String(1000), nullable=False)
    file_type: Mapped[str] = mapped_column(String(30), nullable=False)
    status: Mapped[ImportStatus] = mapped_column(
        Enum(ImportStatus), default=ImportStatus.PENDING, nullable=False
    )
    record_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    invalid_record_count: Mapped[int] = mapped_column(
        Integer, default=0, nullable=False
    )
    error_message: Mapped[str | None] = mapped_column(Text)
    created_by_id: Mapped[str] = mapped_column(ForeignKey("users.id"), nullable=False)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    mapping: Mapped[dict | None] = mapped_column(JSONType)

    search_source: Mapped[SearchSource | None] = relationship(
        back_populates="import_batches"
    )
    records: Mapped[list[ImportedRecord]] = relationship(
        back_populates="import_batch", cascade="all, delete-orphan"
    )


class ImportedRecord(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "imported_records"

    import_batch_id: Mapped[str] = mapped_column(
        ForeignKey("import_batches.id", ondelete="CASCADE"), index=True
    )
    source_row: Mapped[int | None] = mapped_column(Integer)
    source_key: Mapped[str | None] = mapped_column(String(300))
    raw_data: Mapped[dict] = mapped_column(JSONType, nullable=False)
    parsed_data: Mapped[dict] = mapped_column(JSONType, nullable=False)
    validation_state: Mapped[str] = mapped_column(
        String(30), default="valid", nullable=False
    )
    warnings: Mapped[list] = mapped_column(JSONType, default=list, nullable=False)

    import_batch: Mapped[ImportBatch] = relationship(back_populates="records")
