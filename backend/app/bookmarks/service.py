"""Private, per-user publication bookmarks.

Bookmarks stay on the publication they were made on. When deduplication
merges that publication into another, the bookmark is resolved to the
canonical publication on read instead of being moved, so undoing the merge
needs no bookmark bookkeeping. A bookmark whose publication was deleted from
the review (inactive, not merged) is simply not shown.
"""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.accounts.models import User
from app.api.errors import NotFoundError
from app.bookmarks.models import PublicationBookmark
from app.projects.models import ProjectMembership
from app.publications.models import Publication


def _canonical(db: Session, publication: Publication | None) -> Publication | None:
    seen: set[str] = set()
    while publication is not None and not publication.is_active:
        if publication.merged_into_id is None or publication.id in seen:
            return None
        seen.add(publication.id)
        publication = db.get(Publication, publication.merged_into_id)
    return publication


def _project_publication(
    db: Session, project_id: str, publication_id: str
) -> Publication:
    publication = db.get(Publication, publication_id)
    if (
        publication is None
        or publication.project_id != project_id
        or not publication.is_active
    ):
        raise NotFoundError("Publication not found")
    return publication


def _resolved_bookmarks(
    db: Session, user: User, project_id: str | None = None
) -> list[tuple[PublicationBookmark, Publication]]:
    """The user's bookmarks paired with their canonical publication, oldest
    first, with at most one entry per canonical publication."""
    query = (
        select(PublicationBookmark, Publication)
        .join(Publication, Publication.id == PublicationBookmark.publication_id)
        .where(PublicationBookmark.user_id == user.id)
        .order_by(PublicationBookmark.created_at, PublicationBookmark.id)
    )
    if project_id is not None:
        query = query.where(PublicationBookmark.project_id == project_id)
    elif not user.is_admin:
        query = query.where(
            PublicationBookmark.project_id.in_(
                select(ProjectMembership.project_id).where(
                    ProjectMembership.user_id == user.id
                )
            )
        )
    resolved: dict[str, tuple[PublicationBookmark, Publication]] = {}
    for bookmark, publication in db.execute(query).tuples():
        canonical = _canonical(db, publication)
        if canonical is not None and canonical.id not in resolved:
            resolved[canonical.id] = (bookmark, canonical)
    return list(resolved.values())


def project_bookmark_ids(db: Session, user: User, project_id: str) -> list[str]:
    return [
        publication.id
        for _, publication in _resolved_bookmarks(db, user, project_id)
    ]


def list_bookmarks(
    db: Session, user: User
) -> list[tuple[PublicationBookmark, Publication]]:
    """Every bookmark the user can still open, newest first."""
    return list(reversed(_resolved_bookmarks(db, user)))


def add_bookmark(
    db: Session, user: User, project_id: str, publication_id: str
) -> None:
    publication = _project_publication(db, project_id, publication_id)
    exists = db.scalar(
        select(PublicationBookmark.id).where(
            PublicationBookmark.user_id == user.id,
            PublicationBookmark.publication_id == publication.id,
        )
    )
    if exists is not None:
        return
    try:
        with db.begin_nested():
            db.add(
                PublicationBookmark(
                    user_id=user.id,
                    project_id=project_id,
                    publication_id=publication.id,
                )
            )
    except IntegrityError:
        # A concurrent request bookmarked it first; the outcome is the same.
        pass


def remove_bookmarks(db: Session, user: User, publication_ids: list[str]) -> int:
    """Remove the user's bookmarks on the given (canonical) publications,
    including those made on publications later merged into them. Unknown ids
    are ignored. Returns how many of the requested publications were
    bookmarked."""
    wanted = set(publication_ids)
    removed: set[str] = set()
    bookmarks = db.scalars(
        select(PublicationBookmark).where(PublicationBookmark.user_id == user.id)
    )
    for bookmark in bookmarks:
        if bookmark.publication_id in wanted:
            removed.add(bookmark.publication_id)
            db.delete(bookmark)
            continue
        canonical = _canonical(db, db.get(Publication, bookmark.publication_id))
        if canonical is not None and canonical.id in wanted:
            removed.add(canonical.id)
            db.delete(bookmark)
    return len(removed)


def remove_bookmark(
    db: Session, user: User, project_id: str, publication_id: str
) -> None:
    publication = db.get(Publication, publication_id)
    if publication is None or publication.project_id != project_id:
        raise NotFoundError("Publication not found")
    bookmarks = db.scalars(
        select(PublicationBookmark).where(
            PublicationBookmark.user_id == user.id,
            PublicationBookmark.project_id == project_id,
        )
    )
    for bookmark in bookmarks:
        if bookmark.publication_id == publication.id:
            db.delete(bookmark)
            continue
        canonical = _canonical(db, db.get(Publication, bookmark.publication_id))
        if canonical is not None and canonical.id == publication.id:
            db.delete(bookmark)
