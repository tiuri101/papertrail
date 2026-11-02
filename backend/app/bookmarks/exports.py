"""Exporting a user's bookmarks as one metadata.bib + PDFs bundle.

Bookmarks span projects, so this can't reuse the project-scoped
``generate_export`` job and ``ExportArtifact`` rows. The bundle is still built
by the background worker; the zip lives at a path derived from the job id and
is only ever served to the user who queued it. Each user keeps just their
latest bookmark export on disk -- a new one replaces the previous file.
"""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.accounts.models import User
from app.api.errors import DomainError, NotFoundError
from app.bookmarks.service import list_bookmarks
from app.core.config import get_settings
from app.jobs.models import BackgroundJob
from app.jobs.service import enqueue_job
from app.reporting.bundle import build_bundle_for_publications

BOOKMARK_EXPORT_JOB = "export_bookmarks"


def bookmark_export_path(job_id: str) -> Path:
    return get_settings().export_dir / "bookmarks" / f"{job_id}.zip"


def queue_bookmark_export(
    db: Session, user: User, publication_ids: list[str] | None
) -> BackgroundJob:
    """Queue an export of the given bookmarked publications, or of all the
    user's bookmarks when ``publication_ids`` is None."""
    bookmarked = {publication.id for _, publication in list_bookmarks(db, user)}
    selected = bookmarked if publication_ids is None else bookmarked & set(publication_ids)
    if not selected:
        raise DomainError("Select at least one bookmarked publication to export")
    return enqueue_job(
        db,
        BOOKMARK_EXPORT_JOB,
        {"publication_ids": publication_ids},
        project_id=None,
        created_by_id=user.id,
    )


def user_bookmark_export_job(db: Session, user: User, job_id: str) -> BackgroundJob:
    job = db.get(BackgroundJob, job_id)
    if job is None or job.job_type != BOOKMARK_EXPORT_JOB or job.created_by_id != user.id:
        raise NotFoundError("Export not found")
    return job


def export_bookmarks_job(db: Session, job: BackgroundJob) -> dict[str, Any]:
    user = db.get(User, job.created_by_id) if job.created_by_id else None
    if user is None:
        raise ValueError("Export owner not found")
    # Re-resolved here rather than trusted from the payload: the export only
    # ever contains publications the owner has bookmarked and can still open
    # at the time it runs.
    requested = job.payload.get("publication_ids")
    publications = [
        publication
        for _, publication in list_bookmarks(db, user)
        if requested is None or publication.id in requested
    ]
    path = bookmark_export_path(job.id)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(build_bundle_for_publications(db, publications))
    previous = db.scalars(
        select(BackgroundJob.id).where(
            BackgroundJob.job_type == BOOKMARK_EXPORT_JOB,
            BackgroundJob.created_by_id == user.id,
            BackgroundJob.id != job.id,
            BackgroundJob.created_at < job.created_at,
        )
    )
    for previous_id in previous:
        bookmark_export_path(previous_id).unlink(missing_ok=True)
    date_str = datetime.now(UTC).strftime("%Y-%m-%d")
    return {
        "filename": f"bookmarks_{date_str}.zip",
        "publicationCount": len(publications),
    }
