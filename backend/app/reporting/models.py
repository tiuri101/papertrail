from __future__ import annotations

from sqlalchemy import ForeignKey, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, TimestampMixin, UUIDPrimaryKeyMixin


class ExportArtifact(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "export_artifacts"
    __table_args__ = (UniqueConstraint("job_id", name="uq_export_artifact_job"),)

    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    job_id: Mapped[str | None] = mapped_column(ForeignKey("background_jobs.id", ondelete="SET NULL"), index=True)
    export_type: Mapped[str] = mapped_column(String(30), index=True, nullable=False)
    filename: Mapped[str] = mapped_column(String(500), nullable=False)
    stored_path: Mapped[str] = mapped_column(String(1000), nullable=False)
    created_by_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
