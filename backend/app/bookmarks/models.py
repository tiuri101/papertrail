from __future__ import annotations

from sqlalchemy import ForeignKey, Index, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, TimestampMixin, UUIDPrimaryKeyMixin


class PublicationBookmark(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """A reviewer's private bookmark on one publication.

    Bookmarks are personal reading aids, not review data: no other user sees
    them, and they never influence screening, extraction or final decisions.
    A bookmark is left on its original publication when that publication is
    merged into another (merges are undoable); readers resolve it to the
    canonical publication instead (see ``app.bookmarks.service``).
    """

    __tablename__ = "publication_bookmarks"
    __table_args__ = (
        UniqueConstraint("user_id", "publication_id"),
        Index("ix_publication_bookmarks_user_project", "user_id", "project_id"),
    )

    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True
    )
    publication_id: Mapped[str] = mapped_column(
        ForeignKey("publications.id", ondelete="CASCADE"), nullable=False, index=True
    )
