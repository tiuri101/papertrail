from __future__ import annotations

from datetime import UTC, datetime
from uuid import uuid4

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.errors import ConflictError
from app.audit.service import record_audit
from app.fulltext.models import DocumentSource, PublicationDocument
from app.fulltext.storage import StoredPdf, count_pdf_pages, discard_pdf, promote_pdf


def active_document(db: Session, publication_id: str) -> PublicationDocument | None:
    return db.scalar(
        select(PublicationDocument).where(
            PublicationDocument.publication_id == publication_id,
            PublicationDocument.is_active.is_(True),
        )
    )


def attach_staged_pdf(
    db: Session,
    *,
    project_id: str,
    publication_id: str,
    staged: StoredPdf,
    user_id: str | None,
    source: DocumentSource,
    import_batch_id: str | None = None,
    replace: bool = False,
    audit_action: str | None = None,
) -> PublicationDocument:
    current = active_document(db, publication_id)
    if current and current.sha256 == staged.sha256:
        raise ConflictError("This PDF is already attached to the publication")
    if current and not replace:
        raise ConflictError("The publication already has an active PDF")

    document_id = str(uuid4())
    page_count = count_pdf_pages(staged.storage_key)
    final_key = promote_pdf(staged.storage_key, project_id, publication_id, document_id)
    document = PublicationDocument(
        id=document_id,
        project_id=project_id,
        publication_id=publication_id,
        original_filename=staged.original_filename,
        storage_key=final_key,
        mime_type="application/pdf",
        file_size=staged.file_size,
        page_count=page_count,
        sha256=staged.sha256,
        uploaded_by_user_id=user_id,
        source=source,
        import_batch_id=import_batch_id,
    )
    try:
        if current:
            # PostgreSQL checks the replacement foreign key immediately, while the
            # partial unique index allows only one active document. Deactivate the
            # old row before inserting and linking its replacement.
            current.is_active = False
            db.flush()
        db.add(document)
        db.flush()
        if current:
            current.replaced_by_document_id = document.id
            db.flush()
    except Exception:
        discard_pdf(final_key)
        raise
    action = audit_action or (
        "pdf.replaced"
        if current
        else (
            "pdf.attached_bulk"
            if source == DocumentSource.BULK_IMPORT
            else "pdf.uploaded_manual"
        )
    )
    record_audit(
        db,
        action=action,
        entity_type="publication_document",
        entity_id=document.id,
        project_id=project_id,
        actor_id=user_id,
        summary="Replaced full-text PDF" if current else "Attached full-text PDF",
        metadata={
            "publicationId": publication_id,
            "documentId": document.id,
            "previousDocumentId": current.id if current else None,
            "importBatchId": import_batch_id,
            "source": source.value,
        },
    )
    from app.llm.task_service import queue_document_processing

    queue_document_processing(db, publication_id, created_by_id=user_id, priority=0)
    return document


def remove_active_pdf(
    db: Session, *, project_id: str, publication_id: str, user_id: str
) -> PublicationDocument:
    current = active_document(db, publication_id)
    if current is None:
        raise ConflictError("The publication has no active PDF")
    current.is_active = False
    current.removed_at = datetime.now(UTC)
    current.removed_by_user_id = user_id
    record_audit(
        db,
        action="pdf.removed",
        entity_type="publication_document",
        entity_id=current.id,
        project_id=project_id,
        actor_id=user_id,
        summary="Removed active full-text PDF",
        metadata={"publicationId": publication_id, "documentId": current.id},
    )
    from app.llm.service import cancel_queued_for_publication

    cancel_queued_for_publication(db, publication_id)
    db.flush()
    return current
