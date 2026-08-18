from __future__ import annotations

from sqlalchemy import Boolean, Float, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, TimestampMixin, UUIDPrimaryKeyMixin


class InstanceSettings(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """Administrator-managed overrides for installation-wide operational defaults
    (email delivery, background job tuning, PDF handling, account security).

    Mirrors app.llm.models.LlmInstallationSettings: a single row, environment
    variables provide the defaults, this table holds admin overrides.
    """

    __tablename__ = "instance_settings"

    email_enabled: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    public_base_url: Mapped[str] = mapped_column(String(2000), nullable=False)
    smtp_host: Mapped[str | None] = mapped_column(String(500))
    smtp_port: Mapped[int] = mapped_column(Integer, nullable=False)
    smtp_username: Mapped[str | None] = mapped_column(String(500))
    smtp_password: Mapped[str | None] = mapped_column(String(500))
    smtp_from_address: Mapped[str | None] = mapped_column(String(500))
    smtp_starttls: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    smtp_use_ssl: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    smtp_timeout_seconds: Mapped[int] = mapped_column(Integer, nullable=False)
    worker_threads: Mapped[int] = mapped_column(Integer, nullable=False)
    job_poll_interval_seconds: Mapped[float] = mapped_column(Float, nullable=False)
    job_lease_seconds: Mapped[int] = mapped_column(Integer, nullable=False)
    browser_retrieval_lease_seconds: Mapped[int] = mapped_column(
        Integer, nullable=False
    )
    max_pdf_size_mb: Mapped[int] = mapped_column(Integer, nullable=False)
    password_reset_ttl_minutes: Mapped[int] = mapped_column(Integer, nullable=False)
    password_reset_max_attempts: Mapped[int] = mapped_column(Integer, nullable=False)
    updated_by_user_id: Mapped[str | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
