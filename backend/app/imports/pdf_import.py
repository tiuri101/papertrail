from __future__ import annotations

import tempfile
import zipfile
from datetime import UTC, datetime
from pathlib import PurePosixPath

from fastapi import UploadFile
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.api.errors import DomainError
from app.audit.service import record_audit
from app.core.config import Settings
from app.fulltext.documents import active_document, attach_staged_pdf
from app.fulltext.models import DocumentSource
from app.fulltext.storage import (
    StoredPdf,
    discard_pdf,
    safe_display_filename,
    stage_pdf_stream,
    stage_pdf_upload,
)
from app.imports.models import (
    ImportBatch,
    ImportedRecord,
    ImportPdfItem,
    ImportStatus,
    PdfMatchStatus,
)
from app.imports.pdf_matching import match_pdf
from app.instance_settings.service import effective_instance_settings
from app.publications.models import Publication, PublicationSource


def _item_from_staged(batch: ImportBatch, staged: StoredPdf) -> ImportPdfItem:
    return ImportPdfItem(
        import_batch_id=batch.id,
        project_id=batch.project_id,
        original_filename=staged.original_filename,
        storage_key=staged.storage_key,
        mime_type="application/pdf",
        file_size=staged.file_size,
        sha256=staged.sha256,
        detected_doi=staged.detected_doi,
        detected_title=staged.detected_title,
        detected_authors=staged.detected_authors,
        detected_year=staged.detected_year,
    )


def _invalid_item(
    batch: ImportBatch, filename: str | None, error: Exception | str
) -> ImportPdfItem:
    return ImportPdfItem(
        import_batch_id=batch.id,
        project_id=batch.project_id,
        original_filename=safe_display_filename(filename),
        status=PdfMatchStatus.INVALID,
        error_message=str(error),
    )


def _mark_duplicate_in_batch(
    db: Session, batch: ImportBatch, item: ImportPdfItem
) -> None:
    if not item.sha256:
        return
    duplicate = db.scalar(
        select(ImportPdfItem.id).where(
            ImportPdfItem.import_batch_id == batch.id,
            ImportPdfItem.sha256 == item.sha256,
            ImportPdfItem.id != item.id,
            ImportPdfItem.status != PdfMatchStatus.INVALID,
        )
    )
    if duplicate:
        item.status = PdfMatchStatus.DUPLICATE
        item.error_message = "Identical PDF already exists in this import batch"
        discard_pdf(item.storage_key)
        item.storage_key = None


async def _stage_pdf_archive(
    db: Session,
    batch: ImportBatch,
    pdf_archive: UploadFile,
    *,
    settings: Settings,
    remaining_file_slots: int,
    remaining_expanded_bytes: int,
) -> tuple[int, int, int]:
    """Stage one archive and isolate its failure from all other uploaded archives."""
    archive_limit = settings.max_pdf_archive_size_mb * 1024 * 1024
    archive_path = None
    staged_count = 0
    try:
        with tempfile.NamedTemporaryFile(suffix=".zip", delete=False) as temp:
            archive_path = temp.name
            size = 0
            while chunk := await pdf_archive.read(1024 * 1024):
                size += len(chunk)
                if size > archive_limit:
                    raise DomainError(
                        f"PDF ZIP exceeds the {settings.max_pdf_archive_size_mb} MB limit"
                    )
                temp.write(chunk)
        with zipfile.ZipFile(archive_path) as archive:
            infos = [entry for entry in archive.infolist() if not entry.is_dir()]
            if len(infos) > remaining_file_slots:
                raise DomainError(
                    f"A PDF batch may contain at most {settings.max_pdf_batch_files} files"
                )
            expanded = sum(entry.file_size for entry in infos)
            if expanded > remaining_expanded_bytes:
                raise DomainError("PDF ZIPs expand beyond the configured safety limit")
            for entry in infos:
                entry_path = PurePosixPath(entry.filename.replace("\\", "/"))
                unsafe = entry_path.is_absolute() or ".." in entry_path.parts
                suspicious = (
                    entry.compress_size > 0
                    and entry.file_size / entry.compress_size > 200
                )
                if unsafe or suspicious:
                    db.add(
                        _invalid_item(
                            batch,
                            entry.filename,
                            (
                                "Unsafe ZIP entry"
                                if unsafe
                                else "Suspicious ZIP compression ratio"
                            ),
                        )
                    )
                elif entry_path.suffix.lower() != ".pdf":
                    db.add(
                        _invalid_item(batch, entry.filename, "ZIP entry is not a PDF")
                    )
                else:
                    try:
                        with archive.open(entry) as stream:
                            staged = stage_pdf_stream(
                                stream,
                                entry_path.name,
                                import_batch_id=batch.id,
                                settings=settings,
                            )
                        item = _item_from_staged(batch, staged)
                    except Exception as exc:
                        item = _invalid_item(batch, entry.filename, exc)
                    db.add(item)
                    db.flush()
                    _mark_duplicate_in_batch(db, batch, item)
                staged_count += 1
        return staged_count, len(infos), expanded
    except Exception as exc:
        db.add(_invalid_item(batch, pdf_archive.filename, exc))
        return 1, 0, 0
    finally:
        await pdf_archive.close()
        if archive_path:
            from pathlib import Path

            Path(archive_path).unlink(missing_ok=True)


async def stage_bulk_uploads(
    db: Session,
    batch: ImportBatch,
    pdfs: list[UploadFile],
    pdf_archives: list[UploadFile],
) -> int:
    settings = effective_instance_settings(db)
    if len(pdfs) + len(pdf_archives) > settings.max_pdf_batch_files:
        raise DomainError(
            f"A PDF batch may contain at most {settings.max_pdf_batch_files} uploads"
        )
    staged_count = 0
    for upload in pdfs:
        try:
            staged = await stage_pdf_upload(
                upload, import_batch_id=batch.id, settings=settings
            )
            item = _item_from_staged(batch, staged)
        except Exception as exc:
            item = _invalid_item(batch, upload.filename, exc)
        db.add(item)
        db.flush()
        _mark_duplicate_in_batch(db, batch, item)
        staged_count += 1

    remaining_file_slots = settings.max_pdf_batch_files - len(pdfs)
    remaining_expanded_bytes = settings.max_pdf_zip_expanded_bytes
    for pdf_archive in pdf_archives:
        archive_staged, archive_files, archive_expanded = await _stage_pdf_archive(
            db,
            batch,
            pdf_archive,
            settings=settings,
            remaining_file_slots=remaining_file_slots,
            remaining_expanded_bytes=remaining_expanded_bytes,
        )
        staged_count += archive_staged
        remaining_file_slots -= archive_files
        remaining_expanded_bytes -= archive_expanded
    db.flush()
    return staged_count


PDF_ONLY_FILE_TYPE = "pdf_only"


def create_pdf_only_batch(db: Session, project_id: str, user_id: str) -> ImportBatch:
    """A batch for PDFs uploaded directly against a project's existing publications.

    Unlike a metadata-import batch, it has no source file or imported records, so
    matching is performed against every active publication in the project.
    """
    batch = ImportBatch(
        project_id=project_id,
        original_filename="Manual PDF upload",
        stored_path="",
        file_type=PDF_ONLY_FILE_TYPE,
        status=ImportStatus.COMPLETED,
        created_by_id=user_id,
        completed_at=datetime.now(UTC),
    )
    db.add(batch)
    db.flush()
    return batch


def batch_publications(db: Session, batch_id: str) -> list[Publication]:
    batch = db.get(ImportBatch, batch_id)
    if batch is not None and batch.file_type == PDF_ONLY_FILE_TYPE:
        return list(
            db.scalars(
                select(Publication)
                .options(selectinload(Publication.documents))
                .where(
                    Publication.project_id == batch.project_id,
                    Publication.is_active.is_(True),
                )
                .order_by(Publication.title)
            )
        )
    return list(
        db.scalars(
            select(Publication)
            .options(selectinload(Publication.documents))
            .join(PublicationSource, PublicationSource.publication_id == Publication.id)
            .join(
                ImportedRecord,
                ImportedRecord.id == PublicationSource.imported_record_id,
            )
            .where(
                ImportedRecord.import_batch_id == batch_id,
                Publication.is_active.is_(True),
            )
            .distinct()
        )
    )


def _stored_from_item(item: ImportPdfItem) -> StoredPdf:
    assert item.storage_key and item.file_size is not None and item.sha256
    return StoredPdf(
        original_filename=item.original_filename,
        storage_key=item.storage_key,
        file_size=item.file_size,
        sha256=item.sha256,
        detected_doi=item.detected_doi,
        detected_title=item.detected_title,
        detected_authors=item.detected_authors,
        detected_year=item.detected_year,
    )


def process_pdf_matches(db: Session, batch: ImportBatch) -> dict[str, int]:
    publications = batch_publications(db, batch.id)
    items = list(
        db.scalars(
            select(ImportPdfItem).where(
                ImportPdfItem.import_batch_id == batch.id,
                ImportPdfItem.status == PdfMatchStatus.PENDING,
            )
        )
    )
    for item in items:
        document = None
        try:
            result = match_pdf(item, publications)
            item.candidate_matches = result.candidates
            if result.publication is None:
                item.status = PdfMatchStatus(result.state)
            else:
                item.matched_publication_id = result.publication.id
                if active_document(db, result.publication.id):
                    item.status = PdfMatchStatus.CONFLICT_EXISTING_PDF
                else:
                    document = attach_staged_pdf(
                        db,
                        project_id=batch.project_id,
                        publication_id=result.publication.id,
                        staged=_stored_from_item(item),
                        user_id=batch.created_by_id,
                        source=DocumentSource.BULK_IMPORT,
                        import_batch_id=batch.id,
                    )
                    item.storage_key = None
                    item.attached_document_id = document.id
                    item.status = PdfMatchStatus.MATCHED
            db.commit()
        except Exception as exc:
            db.rollback()
            discard_pdf(document.storage_key if document else item.storage_key)
            failed = db.get(ImportPdfItem, item.id)
            if failed is not None:
                failed.status = PdfMatchStatus.INVALID
                failed.error_message = str(exc)
                failed.storage_key = None
                db.commit()
    return pdf_summary(db, batch.id)


def resolve_pdf_match(
    db: Session,
    item: ImportPdfItem,
    *,
    publication: Publication | None,
    action: str,
    user_id: str,
) -> None:
    if item.status in {
        PdfMatchStatus.MATCHED,
        PdfMatchStatus.DUPLICATE,
        PdfMatchStatus.INVALID,
    }:
        raise DomainError("This PDF match can no longer be changed")
    if action in {"skip", "keep_existing"}:
        item.status = PdfMatchStatus.SKIPPED
    else:
        if publication is None:
            raise DomainError("Choose a publication")
        replace = action == "replace"
        if action not in {"attach", "replace"}:
            raise DomainError("Unsupported PDF match resolution")
        other = db.scalar(
            select(ImportPdfItem.id).where(
                ImportPdfItem.import_batch_id == item.import_batch_id,
                ImportPdfItem.matched_publication_id == publication.id,
                ImportPdfItem.status == PdfMatchStatus.MATCHED,
                ImportPdfItem.id != item.id,
            )
        )
        if other and not replace:
            raise DomainError(
                "Another PDF in this batch is already attached to that publication"
            )
        document = attach_staged_pdf(
            db,
            project_id=item.project_id,
            publication_id=publication.id,
            staged=_stored_from_item(item),
            user_id=user_id,
            source=DocumentSource.BULK_IMPORT,
            import_batch_id=item.import_batch_id,
            replace=replace,
            audit_action="pdf.conflict_replaced" if replace else "pdf.attached_bulk",
        )
        item.storage_key = None
        item.matched_publication_id = publication.id
        item.attached_document_id = document.id
        item.status = PdfMatchStatus.MATCHED
    item.resolved_by_id = user_id
    item.resolved_at = datetime.now(UTC)
    record_audit(
        db,
        action="pdf.match_resolved",
        entity_type="import_pdf_item",
        entity_id=item.id,
        project_id=item.project_id,
        actor_id=user_id,
        summary=f"Resolved bulk PDF match as {item.status.value}",
        metadata={
            "importBatchId": item.import_batch_id,
            "publicationId": publication.id if publication else None,
            "documentId": item.attached_document_id,
            "resolution": action,
        },
    )
    db.flush()


def _summarize_statuses(statuses: list[PdfMatchStatus]) -> dict[str, int]:
    summary = {"total": len(statuses)}
    for state in PdfMatchStatus:
        summary[state.value] = sum(status == state for status in statuses)
    return summary


def pdf_summary(db: Session, batch_id: str) -> dict[str, int]:
    statuses = list(
        db.scalars(
            select(ImportPdfItem.status).where(
                ImportPdfItem.import_batch_id == batch_id
            )
        )
    )
    return _summarize_statuses(statuses)


def project_pdf_summary(db: Session, project_id: str) -> dict[str, int]:
    statuses = list(
        db.scalars(
            select(ImportPdfItem.status).where(ImportPdfItem.project_id == project_id)
        )
    )
    return _summarize_statuses(statuses)
