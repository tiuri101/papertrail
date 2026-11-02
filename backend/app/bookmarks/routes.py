from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, status
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from app.accounts.dependencies import get_current_user, require_csrf
from app.accounts.models import User, UserSession
from app.api.errors import NotFoundError
from app.audit.service import record_audit
from app.bookmarks.exports import (
    bookmark_export_path,
    queue_bookmark_export,
    user_bookmark_export_job,
)
from app.bookmarks.schemas import (
    BookmarkExportRequest,
    BookmarkExportStatus,
    BookmarkIdsResponse,
    BookmarkItem,
    BookmarkSelection,
)
from app.bookmarks.service import (
    add_bookmark,
    list_bookmarks,
    project_bookmark_ids,
    remove_bookmark,
    remove_bookmarks,
)
from app.db.session import get_db
from app.jobs.models import JobStatus
from app.jobs.sanitize import public_error_message
from app.projects.dependencies import require_project_member_csrf
from app.projects.service import require_project_access

# Bookmarks are a private reading aid, not review data, so -- like the
# cosmetic UI preferences -- toggling one is not written to the audit log.
# Exporting them is: the bundle carries PDFs out of the projects.
router = APIRouter(tags=["bookmarks"])


@router.post("/bookmarks/remove")
def remove_selected_bookmarks(
    payload: BookmarkSelection,
    session: UserSession = Depends(require_csrf),
    db: Session = Depends(get_db),
) -> dict[str, int]:
    removed = remove_bookmarks(db, session.user, payload.publication_ids)
    db.commit()
    return {"removedCount": removed}


@router.post("/bookmarks/exports", status_code=status.HTTP_202_ACCEPTED)
def create_bookmark_export(
    payload: BookmarkExportRequest,
    session: UserSession = Depends(require_csrf),
    db: Session = Depends(get_db),
) -> dict[str, str]:
    user = session.user
    job = queue_bookmark_export(db, user, payload.publication_ids)
    record_audit(
        db,
        action="bookmarks.export_queued",
        entity_type="background_job",
        entity_id=job.id,
        actor_id=user.id,
        summary="Queued export of bookmarked publications",
    )
    db.commit()
    return {"jobId": job.id}


@router.get("/bookmarks/exports/{job_id}", response_model=BookmarkExportStatus)
def get_bookmark_export(
    job_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> BookmarkExportStatus:
    job = user_bookmark_export_job(db, user, job_id)
    result: dict[str, Any] = job.result or {}
    completed = job.status == JobStatus.COMPLETED
    return BookmarkExportStatus(
        job_id=job.id,
        status=job.status,
        error_message=public_error_message(job.error_message),
        filename=result.get("filename") if completed else None,
        publication_count=result.get("publicationCount") if completed else None,
    )


@router.get("/bookmarks/exports/{job_id}/download")
def download_bookmark_export(
    job_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> FileResponse:
    job = user_bookmark_export_job(db, user, job_id)
    path = bookmark_export_path(job.id)
    if job.status != JobStatus.COMPLETED or not path.is_file():
        raise NotFoundError("Export not found")
    filename = (job.result or {}).get("filename") or "bookmarks.zip"
    return FileResponse(path, filename=filename, media_type="application/zip")


@router.get("/bookmarks", response_model=list[BookmarkItem])
def get_bookmarks(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[BookmarkItem]:
    return [
        BookmarkItem(
            publication_id=publication.id,
            project_id=publication.project_id,
            title=publication.title,
            authors=publication.authors,
            publication_year=publication.publication_year,
            venue=publication.venue,
            doi=publication.doi,
            publisher_url=publication.publisher_url,
            bookmarked_at=bookmark.created_at,
        )
        for bookmark, publication in list_bookmarks(db, user)
    ]


@router.get(
    "/projects/{project_id}/bookmarks/ids", response_model=BookmarkIdsResponse
)
def get_project_bookmark_ids(
    project_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> BookmarkIdsResponse:
    require_project_access(db, project_id, user)
    return BookmarkIdsResponse(
        publication_ids=project_bookmark_ids(db, user, project_id)
    )


@router.put(
    "/projects/{project_id}/publications/{publication_id}/bookmark",
    status_code=status.HTTP_204_NO_CONTENT,
)
def put_bookmark(
    project_id: str,
    publication_id: str,
    user: User = Depends(require_project_member_csrf),
    db: Session = Depends(get_db),
) -> None:
    add_bookmark(db, user, project_id, publication_id)
    db.commit()


@router.delete(
    "/projects/{project_id}/publications/{publication_id}/bookmark",
    status_code=status.HTTP_204_NO_CONTENT,
)
def delete_bookmark(
    project_id: str,
    publication_id: str,
    user: User = Depends(require_project_member_csrf),
    db: Session = Depends(get_db),
) -> None:
    remove_bookmark(db, user, project_id, publication_id)
    db.commit()
