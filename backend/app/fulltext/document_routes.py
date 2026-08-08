from __future__ import annotations

from uuid import uuid4

from fastapi import APIRouter, Depends, File, UploadFile, status
from fastapi.responses import FileResponse
from sqlalchemy import Select, select
from sqlalchemy.orm import Session, joinedload

from app.accounts.dependencies import get_current_user
from app.accounts.models import User
from app.api.errors import NotFoundError
from app.db.session import get_db
from app.fulltext.documents import active_document, attach_staged_pdf, remove_active_pdf
from app.fulltext.models import (
    DocumentSource,
    FullTextRetrieval,
    PublicationDocument,
    RetrievalStatus,
)
from app.fulltext.schemas import DocumentResponse, FullTextDocumentResponse
from app.fulltext.service import set_retrieval_status
from app.fulltext.storage import discard_pdf, stage_pdf_upload, storage_path
from app.projects.dependencies import require_full_text_reviewer_csrf
from app.projects.service import require_project_access
from app.publications.models import Publication

router = APIRouter(tags=["full-text documents"])


def _publication(db: Session, project_id: str, publication_id: str) -> Publication:
    publication = db.get(Publication, publication_id)
    if publication is None or publication.project_id != project_id:
        raise NotFoundError("Publication not found")
    return publication


def _document_query(publication_id: str) -> Select[tuple[PublicationDocument]]:
    return (
        select(PublicationDocument)
        .options(joinedload(PublicationDocument.uploaded_by))
        .where(PublicationDocument.publication_id == publication_id)
    )


@router.get(
    "/projects/{project_id}/publications/{publication_id}/full-text",
    response_model=FullTextDocumentResponse,
)
def get_full_text_document(
    project_id: str,
    publication_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, object]:
    require_project_access(db, project_id, user)
    _publication(db, project_id, publication_id)
    document = db.scalar(
        _document_query(publication_id).where(PublicationDocument.is_active.is_(True))
    )
    return {"available": document is not None, "document": document}


@router.post(
    "/projects/{project_id}/publications/{publication_id}/full-text",
    response_model=FullTextDocumentResponse,
    status_code=status.HTTP_201_CREATED,
)
async def upload_full_text_document(
    project_id: str,
    publication_id: str,
    file: UploadFile = File(...),
    reviewer: User = Depends(require_full_text_reviewer_csrf),
    db: Session = Depends(get_db),
) -> dict[str, object]:
    _publication(db, project_id, publication_id)
    staged = await stage_pdf_upload(file, import_batch_id=f"manual-{uuid4()}")
    document = None
    try:
        document = attach_staged_pdf(
            db,
            project_id=project_id,
            publication_id=publication_id,
            staged=staged,
            user_id=reviewer.id,
            source=DocumentSource.MANUAL,
            replace=active_document(db, publication_id) is not None,
        )
        retrieval = db.scalar(
            select(FullTextRetrieval).where(
                FullTextRetrieval.publication_id == publication_id
            )
        )
        if retrieval is not None and retrieval.status != RetrievalStatus.AVAILABLE:
            set_retrieval_status(
                db, retrieval, RetrievalStatus.AVAILABLE, user_id=reviewer.id
            )
        db.commit()
        db.refresh(document)
        return {"available": True, "document": document}
    except Exception:
        db.rollback()
        discard_pdf(document.storage_key if document else staged.storage_key)
        raise


@router.get("/projects/{project_id}/publications/{publication_id}/full-text/content")
def view_full_text_document(
    project_id: str,
    publication_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> FileResponse:
    require_project_access(db, project_id, user)
    _publication(db, project_id, publication_id)
    document = active_document(db, publication_id)
    if document is None:
        raise NotFoundError("No active PDF is attached")
    path = storage_path(document.storage_key)
    if not path.is_file():
        raise NotFoundError("PDF file is unavailable")
    return FileResponse(
        path,
        media_type="application/pdf",
        filename=document.original_filename,
        content_disposition_type="inline",
    )


@router.delete(
    "/projects/{project_id}/publications/{publication_id}/full-text",
    status_code=status.HTTP_204_NO_CONTENT,
)
def delete_full_text_document(
    project_id: str,
    publication_id: str,
    reviewer: User = Depends(require_full_text_reviewer_csrf),
    db: Session = Depends(get_db),
) -> None:
    _publication(db, project_id, publication_id)
    remove_active_pdf(
        db, project_id=project_id, publication_id=publication_id, user_id=reviewer.id
    )
    db.commit()


@router.get(
    "/projects/{project_id}/publications/{publication_id}/full-text/history",
    response_model=list[DocumentResponse],
)
def full_text_document_history(
    project_id: str,
    publication_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[PublicationDocument]:
    require_project_access(db, project_id, user)
    _publication(db, project_id, publication_id)
    return list(
        db.scalars(
            _document_query(publication_id).order_by(
                PublicationDocument.uploaded_at.desc()
            )
        ).unique()
    )
