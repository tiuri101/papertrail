from __future__ import annotations

import enum
from datetime import UTC, datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    Enum,
    ForeignKey,
    Index,
    String,
    UniqueConstraint,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, TimestampMixin, UUIDPrimaryKeyMixin


class RetrievalStatus(enum.StrEnum):
    NOT_YET_SOUGHT = "not_yet_sought"
    AVAILABLE = "available"
    REQUESTED = "requested"
    NOT_FOUND = "not_found"
    INACCESSIBLE = "inaccessible"


class FullTextRetrieval(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "full_text_retrievals"
    __table_args__ = (
        UniqueConstraint("publication_id", name="uq_full_text_retrieval_publication"),
    )

    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
    publication_id: Mapped[str] = mapped_column(
        ForeignKey("publications.id", ondelete="CASCADE"), index=True
    )
    status: Mapped[RetrievalStatus] = mapped_column(
        default=RetrievalStatus.NOT_YET_SOUGHT, index=True, nullable=False
    )
    note: Mapped[str | None] = mapped_column(String(500))
    updated_by_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    claimed_by_id: Mapped[str | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), index=True
    )
    claimed_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)

    publication = relationship("Publication", foreign_keys=[publication_id])


class DocumentSource(enum.StrEnum):
    MANUAL = "manual"
    BULK_IMPORT = "bulk_import"


class PublicationDocument(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "publication_documents"
    __table_args__ = (
        Index(
            "uq_publication_documents_active_primary",
            "publication_id",
            unique=True,
            postgresql_where=text("is_active = true"),
            sqlite_where=text("is_active = 1"),
        ),
        Index("ix_publication_documents_project_hash", "project_id", "sha256"),
    )

    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
    publication_id: Mapped[str] = mapped_column(
        ForeignKey("publications.id", ondelete="CASCADE"), index=True
    )
    original_filename: Mapped[str] = mapped_column(String(500), nullable=False)
    storage_key: Mapped[str] = mapped_column(String(1000), unique=True, nullable=False)
    mime_type: Mapped[str] = mapped_column(String(100), default="application/pdf", nullable=False)
    file_size: Mapped[int] = mapped_column(BigInteger, nullable=False)
    sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    uploaded_by_user_id: Mapped[str | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), index=True
    )
    uploaded_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(UTC), nullable=False
    )
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    replaced_by_document_id: Mapped[str | None] = mapped_column(
        ForeignKey("publication_documents.id", ondelete="SET NULL")
    )
    removed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    removed_by_user_id: Mapped[str | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    source: Mapped[DocumentSource] = mapped_column(
        Enum(DocumentSource), default=DocumentSource.MANUAL, nullable=False
    )
    import_batch_id: Mapped[str | None] = mapped_column(
        ForeignKey("import_batches.id", ondelete="SET NULL"), index=True
    )

    publication = relationship("Publication", back_populates="documents")
    uploaded_by = relationship("User", foreign_keys=[uploaded_by_user_id])
    removed_by = relationship("User", foreign_keys=[removed_by_user_id])
    replaced_by = relationship("PublicationDocument", remote_side="PublicationDocument.id")
