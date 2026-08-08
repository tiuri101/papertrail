from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from pypdf import PdfReader
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.fulltext.models import PublicationDocument
from app.fulltext.storage import storage_path
from app.jobs.models import BackgroundJob
from app.llm.models import (
    DocumentPageText,
    DocumentTextExtraction,
    ProcessingStatus,
)

EXTRACTOR_NAME = "pypdf"
EXTRACTOR_VERSION = "6"
MIN_USABLE_CHARS = 40


def extraction_for_document(
    db: Session, document_id: str
) -> DocumentTextExtraction | None:
    return db.scalar(
        select(DocumentTextExtraction).where(
            DocumentTextExtraction.document_id == document_id
        )
    )


def ensure_text_extraction(db: Session, document_id: str) -> DocumentTextExtraction:
    extraction = extraction_for_document(db, document_id)
    if extraction is None:
        extraction = DocumentTextExtraction(
            document_id=document_id,
            status=ProcessingStatus.PENDING,
            extractor=EXTRACTOR_NAME,
            extractor_version=EXTRACTOR_VERSION,
        )
        db.add(extraction)
        db.flush()
    return extraction


def extract_document_text_job(db: Session, job: BackgroundJob) -> dict[str, Any]:
    document_id = str(job.payload["document_id"])
    document = db.get(PublicationDocument, document_id)
    if document is None:
        return {"status": "cancelled", "reason": "document_missing"}
    extraction = ensure_text_extraction(db, document_id)
    if extraction.status == ProcessingStatus.COMPLETED:
        from app.llm.service import queue_llm_run_after_text

        queue_llm_run_after_text(db, extraction, created_by_id=job.created_by_id)
        return {"textExtractionId": extraction.id, "idempotent": True}
    path = storage_path(document.storage_key)
    if not path.is_file():
        extraction.status = ProcessingStatus.FAILED
        extraction.error_message = "The stored PDF file is unavailable"
        db.flush()
        return {"textExtractionId": extraction.id, "status": "failed"}
    extraction.status = ProcessingStatus.PROCESSING
    extraction.started_at = datetime.now(UTC)
    extraction.error_message = None
    db.execute(
        delete(DocumentPageText).where(
            DocumentPageText.text_extraction_id == extraction.id
        )
    )
    try:
        reader = PdfReader(path)
        page_texts = [
            (page.extract_text() or "").replace("\x00", "") for page in reader.pages
        ]
    except Exception as exc:
        extraction.status = ProcessingStatus.FAILED
        extraction.error_message = f"PDF text extraction failed: {exc}"
        db.flush()
        return {"textExtractionId": extraction.id, "status": "failed"}
    total_chars = sum(len(text.strip()) for text in page_texts)
    extraction.page_count = len(page_texts)
    extraction.total_chars = total_chars
    extraction.extracted_at = datetime.now(UTC)
    for page_number, page_text in enumerate(page_texts, start=1):
        db.add(
            DocumentPageText(
                text_extraction_id=extraction.id,
                page_number=page_number,
                text=page_text,
            )
        )
    if total_chars < MIN_USABLE_CHARS:
        extraction.status = ProcessingStatus.UNSUPPORTED
        extraction.error_message = (
            "No usable text could be extracted. The PDF may require OCR, which Papertrail "
            "does not perform."
        )
        db.flush()
        return {
            "textExtractionId": extraction.id,
            "status": extraction.status,
            "pageCount": extraction.page_count,
        }
    extraction.status = ProcessingStatus.COMPLETED
    db.flush()
    from app.llm.service import queue_llm_run_after_text

    run = queue_llm_run_after_text(db, extraction, created_by_id=job.created_by_id)
    return {
        "textExtractionId": extraction.id,
        "status": extraction.status,
        "pageCount": extraction.page_count,
        "totalChars": total_chars,
        "llmRunId": run.id if run else None,
    }
