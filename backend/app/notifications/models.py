from __future__ import annotations

import enum
from datetime import datetime
from typing import Any

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, TimestampMixin, UUIDPrimaryKeyMixin
from app.db.types import JSONType


class EmailDeliveryStatus(enum.StrEnum):
    QUEUED = "queued"
    SENDING = "sending"
    SENT = "sent"
    FAILED = "failed"


class EmailNotification(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "email_notifications"

    recipient_user_id: Mapped[str | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), index=True
    )
    project_id: Mapped[str | None] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
    recipient_email: Mapped[str] = mapped_column(String(320), nullable=False)
    template: Mapped[str] = mapped_column(String(100), index=True, nullable=False)
    deduplication_key: Mapped[str] = mapped_column(
        String(64), unique=True, index=True, nullable=False
    )
    subject: Mapped[str] = mapped_column(String(500), nullable=False)
    context: Mapped[dict[str, Any]] = mapped_column(
        JSONType, default=dict, nullable=False
    )
    #: AES-GCM envelope for the credential-bearing part of the payload (today
    #: only the password-reset link). Kept out of `context` on purpose: a read
    #: of this table must not yield a usable credential. Cleared once the email
    #: has been delivered.
    encrypted_context: Mapped[str | None] = mapped_column(Text)
    status: Mapped[EmailDeliveryStatus] = mapped_column(
        String(20), default=EmailDeliveryStatus.QUEUED, index=True, nullable=False
    )
    attempts: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    error_message: Mapped[str | None] = mapped_column(Text)
