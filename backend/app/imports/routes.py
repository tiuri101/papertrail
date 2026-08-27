from __future__ import annotations

from pathlib import Path
from typing import Any
from uuid import uuid4

from fastapi import APIRouter, Depends, File, Form, UploadFile, status
from sqlalchemy import distinct, func, select
from sqlalchemy.orm import Session, selectinload

from app.accounts.dependencies import get_current_user
from app.accounts.models import User
from app.api.errors import (
    DomainError,
    NotFoundError,
    PayloadTooLargeError,
    UnsupportedMediaError,
)
from app.audit.service import record_audit
from app.core.config import get_settings
from app.db.session import get_db
from app.fulltext.models import PublicationDocument
from app.imports.models import (
    ImportBatch,
    ImportedRecord,
    ImportPdfItem,
    ImportStatus,
    SearchSource,
)
from app.imports.pdf_import import (
    batch_publications,
    pdf_summary,
    process_pdf_matches,
    project_pdf_summary,
    resolve_pdf_match,
    stage_bulk_uploads,
)
from app.imports.schemas import (
    JobAccepted,
    PdfMatchResolve,
    SearchSourceCreate,
    SearchSourceResponse,
)
from app.imports.service import preview_or_delete_search, resolve_project_search_source
from app.jobs.service import enqueue_job
from app.projects.dependencies import require_project_member_csrf
from app.projects.file_cleanup import ProjectFileCleanup
from app.projects.service import get_project, require_project_access
from app.publications.models import PublicationSource

router = APIRouter(tags=["imports"])


@router.get(
    "/projects/{project_id}/searches", response_model=list[SearchSourceResponse]
)
def list_searches(
    project_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[SearchSourceResponse]:
    require_project_access(db, project_id, user)
    searches = list(
        db.scalars(
            select(SearchSource)
            .options(
                selectinload(SearchSource.created_by),
                selectinload(SearchSource.import_batches),
            )
            .where(SearchSource.project_id == project_id)
            .order_by(SearchSource.search_date.desc(), SearchSource.created_at.desc())
        )
    )
    batch_ids = [batch.id for search in searches for batch in search.import_batches]
    attached_counts = (
        {
            batch_id: int(count)
            for batch_id, count in db.execute(
                select(
                    ImportedRecord.import_batch_id,
                    func.count(distinct(PublicationSource.publication_id)),
                )
                .join(
                    PublicationSource,
                    PublicationSource.imported_record_id == ImportedRecord.id,
                )
                .join(
                    PublicationDocument,
                    PublicationDocument.publication_id
                    == PublicationSource.publication_id,
                )
                .where(
                    ImportedRecord.import_batch_id.in_(batch_ids),
                    PublicationDocument.is_active.is_(True),
                )
                .group_by(ImportedRecord.import_batch_id)
            )
        }
        if batch_ids
        else {}
    )
    responses = [SearchSourceResponse.model_validate(search) for search in searches]
    for response in responses:
        for batch in response.import_batches:
            batch.attached_paper_count = attached_counts.get(batch.id, 0)
    return responses


@router.post(
    "/projects/{project_id}/searches",
    response_model=SearchSourceResponse,
    status_code=status.HTTP_201_CREATED,
)
def add_search(
    project_id: str,
    payload: SearchSourceCreate,
    admin: User = Depends(require_project_member_csrf),
    db: Session = Depends(get_db),
) -> SearchSource:
    get_project(db, project_id)
    search = SearchSource(
        project_id=project_id,
        source_name=payload.source_name.strip(),
        query=payload.query,
        search_date=payload.search_date,
        filters=payload.filters,
        exported_result_count=payload.exported_result_count,
        created_by_id=admin.id,
    )
    db.add(search)
    db.flush()
    record_audit(
        db,
        action="search.created",
        entity_type="search_source",
        entity_id=search.id,
        project_id=project_id,
        actor_id=admin.id,
        summary=f"Documented search in {search.source_name}",
    )
    db.commit()
    return search


@router.delete("/projects/{project_id}/searches/{search_id}")
def delete_search(
    project_id: str,
    search_id: str,
    force: bool = False,
    admin: User = Depends(require_project_member_csrf),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    search = db.get(SearchSource, search_id)
    if search is None or search.project_id != project_id:
        raise NotFoundError("Search not found")
    source_name = search.source_name
    # Collected before the ImportBatch rows naming these files are deleted;
    # removed only after the commit (app.projects.file_cleanup).
    file_cleanup = ProjectFileCleanup.for_import_batches(
        db, project_id, [batch.id for batch in search.import_batches]
    )
    result = preview_or_delete_search(db, search, force=force)
    if result["deleted"]:
        record_audit(
            db,
            action="search.deleted",
            entity_type="search_source",
            entity_id=search_id,
            project_id=project_id,
            actor_id=admin.id,
            summary=(
                f"Deleted search {source_name} and "
                f"{result['publicationCount']} publication(s)"
            ),
            metadata={"screenedPublicationCount": result["screenedPublicationCount"]},
        )
    db.commit()
    if result["deleted"]:
        file_cleanup.remove()
    return result


@router.post(
    "/projects/{project_id}/imports",
    response_model=list[JobAccepted],
    status_code=status.HTTP_202_ACCEPTED,
)
async def upload_import(
    project_id: str,
    search_source_id: str | None = Form(default=None, alias="searchSourceId"),
    mapping_json: str | None = Form(default=None, alias="mappingJson"),
    files: list[UploadFile] = File(..., alias="file"),
    pdfs: list[UploadFile] = File(default=[]),
    pdf_archives: list[UploadFile] = File(default=[], alias="pdfArchive"),
    admin: User = Depends(require_project_member_csrf),
    db: Session = Depends(get_db),
) -> list[JobAccepted]:
    get_project(db, project_id)
    # Must run before anything is written: a foreign search-source id has to
    # fail before an ImportBatch (or a staged upload) exists for it.
    resolve_project_search_source(db, project_id, search_source_id)

    supported = {".csv", ".tsv", ".xlsx", ".ris", ".bib", ".bibtex"}
    safe_names_and_suffixes = []
    for file in files:
        safe_name = Path(file.filename or "import").name
        suffix = Path(safe_name).suffix.lower()
        if suffix not in supported:
            raise UnsupportedMediaError(f'Unsupported import format: "{safe_name}"')
        safe_names_and_suffixes.append((safe_name, suffix))

    mapping = None
    if mapping_json:
        import json

        try:
            mapping = json.loads(mapping_json)
        except json.JSONDecodeError as exc:
            raise DomainError("Invalid import field mapping") from exc
        if not isinstance(mapping, dict):
            raise DomainError("Import field mapping must be an object")

    settings = get_settings()
    project_dir = settings.import_dir / project_id
    project_dir.mkdir(parents=True, exist_ok=True)

    results: list[JobAccepted] = []
    for index, (file, (safe_name, suffix)) in enumerate(
        zip(files, safe_names_and_suffixes, strict=True)
    ):
        stored_path = project_dir / f"{uuid4()}{suffix}"
        total_bytes = 0
        try:
            with stored_path.open("wb") as destination:
                while chunk := await file.read(1024 * 1024):
                    total_bytes += len(chunk)
                    if total_bytes > settings.max_upload_bytes:
                        raise PayloadTooLargeError(
                            f"Import file exceeds the {settings.max_upload_bytes}-byte limit"
                        )
                    destination.write(chunk)
        except Exception:
            stored_path.unlink(missing_ok=True)
            raise
        finally:
            await file.close()

        batch = ImportBatch(
            project_id=project_id,
            search_source_id=search_source_id,
            original_filename=safe_name,
            stored_path=str(stored_path),
            file_type=suffix.lstrip("."),
            status=ImportStatus.PENDING,
            created_by_id=admin.id,
            mapping=mapping,
        )
        db.add(batch)
        db.flush()
        # PDFs/PDF ZIPs uploaded alongside the metadata files can only be read
        # once, so they're staged against the first batch; the reviewer-facing
        # PDF-match review still lets any of them resolve against any active
        # publication in the project, not just this batch's.
        if index == 0:
            await stage_bulk_uploads(db, batch, pdfs, pdf_archives)
        job = enqueue_job(
            db,
            "parse_import",
            {"import_batch_id": batch.id},
            project_id=project_id,
            created_by_id=admin.id,
        )
        record_audit(
            db,
            action="import.queued",
            entity_type="import_batch",
            entity_id=batch.id,
            project_id=project_id,
            actor_id=admin.id,
            summary=f"Queued import {safe_name}",
            metadata={"bytes": total_bytes},
        )
        results.append(JobAccepted(job_id=job.id, import_batch_id=batch.id))
    db.commit()
    return results


@router.post("/projects/{project_id}/imports/{import_batch_id}/pdfs")
async def upload_import_pdfs(
    project_id: str,
    import_batch_id: str,
    pdfs: list[UploadFile] = File(default=[]),
    pdf_archives: list[UploadFile] = File(default=[], alias="pdfArchive"),
    admin: User = Depends(require_project_member_csrf),
    db: Session = Depends(get_db),
) -> dict[str, object]:
    batch = db.get(ImportBatch, import_batch_id)
    if batch is None or batch.project_id != project_id:
        raise NotFoundError("Import batch not found")
    if batch.status != ImportStatus.COMPLETED:
        raise DomainError("PDFs can be added after the metadata import completes")
    await stage_bulk_uploads(db, batch, pdfs, pdf_archives)
    db.commit()
    summary = process_pdf_matches(db, batch)
    return {"importBatchId": batch.id, "summary": summary}


def _serialize_pdf_item(item: ImportPdfItem) -> dict[str, object]:
    return {
        "id": item.id,
        "originalFilename": item.original_filename,
        "fileSize": item.file_size,
        "sha256": item.sha256,
        "detectedDoi": item.detected_doi,
        "detectedTitle": item.detected_title,
        "detectedAuthors": item.detected_authors,
        "detectedYear": item.detected_year,
        "status": item.status.value,
        "candidates": item.candidate_matches,
        "matchedPublicationId": item.matched_publication_id,
        "attachedDocumentId": item.attached_document_id,
        "errorMessage": item.error_message,
        "importBatchId": item.import_batch_id,
    }


def _serialize_pdf_publication(
    publication: Any, *, in_import_batch: bool
) -> dict[str, object]:
    return {
        "id": publication.id,
        "title": publication.title,
        "authors": publication.authors,
        "publicationYear": publication.publication_year,
        "doi": publication.doi,
        "hasPdf": publication.active_document is not None,
        "inImportBatch": in_import_batch,
    }


def _resolve_pdf_item(
    db: Session,
    project_id: str,
    payload: PdfMatchResolve,
    admin: User,
    *,
    import_batch_id: str | None = None,
) -> ImportPdfItem:
    item = db.get(ImportPdfItem, payload.item_id)
    if (
        item is None
        or item.project_id != project_id
        or (import_batch_id is not None and item.import_batch_id != import_batch_id)
    ):
        raise NotFoundError("PDF import item not found")
    publication = None
    if payload.publication_id:
        from app.publications.models import Publication

        publication = db.get(Publication, payload.publication_id)
        if (
            publication is None
            or publication.project_id != project_id
            or not publication.is_active
        ):
            raise NotFoundError("Publication not found")
    resolve_pdf_match(
        db,
        item,
        publication=publication,
        action=payload.action,
        user_id=admin.id,
    )
    db.commit()
    return item


@router.get("/projects/{project_id}/imports/{import_batch_id}/pdf-matches")
def list_pdf_matches(
    project_id: str,
    import_batch_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, object]:
    require_project_access(db, project_id, user)
    batch = db.get(ImportBatch, import_batch_id)
    if batch is None or batch.project_id != project_id:
        raise NotFoundError("Import batch not found")
    items = list(
        db.scalars(
            select(ImportPdfItem)
            .where(ImportPdfItem.import_batch_id == batch.id)
            .order_by(ImportPdfItem.created_at, ImportPdfItem.id)
        )
    )
    publications = batch_publications(db, batch.id)
    batch_publication_ids = {publication.id for publication in publications}
    from app.publications.models import Publication

    publications.extend(
        db.scalars(
            select(Publication)
            .options(selectinload(Publication.documents))
            .where(
                Publication.project_id == project_id,
                Publication.is_active.is_(True),
                Publication.id.not_in(batch_publication_ids),
            )
            .order_by(Publication.title)
        )
    )
    return {
        "importBatchId": batch.id,
        "summary": pdf_summary(db, batch.id),
        "items": [_serialize_pdf_item(item) for item in items],
        "publications": [
            _serialize_pdf_publication(
                publication, in_import_batch=publication.id in batch_publication_ids
            )
            for publication in publications
        ],
    }


@router.get("/projects/{project_id}/pdf-matches")
def list_project_pdf_matches(
    project_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, object]:
    """All PDF match items for a project, across every import batch.

    Lets reviewers resolve ambiguous/unmatched/conflicting PDFs at any time,
    not only right after the import that staged them.
    """
    require_project_access(db, project_id, user)
    items = list(
        db.scalars(
            select(ImportPdfItem)
            .where(ImportPdfItem.project_id == project_id)
            .order_by(ImportPdfItem.created_at, ImportPdfItem.id)
        )
    )
    from app.publications.models import Publication

    publications = list(
        db.scalars(
            select(Publication)
            .options(selectinload(Publication.documents))
            .where(
                Publication.project_id == project_id,
                Publication.is_active.is_(True),
            )
            .order_by(Publication.title)
        )
    )
    return {
        "summary": project_pdf_summary(db, project_id),
        "items": [_serialize_pdf_item(item) for item in items],
        "publications": [
            _serialize_pdf_publication(publication, in_import_batch=True)
            for publication in publications
        ],
    }


@router.post("/projects/{project_id}/imports/{import_batch_id}/pdf-matches/resolve")
def resolve_import_pdf_match(
    project_id: str,
    import_batch_id: str,
    payload: PdfMatchResolve,
    admin: User = Depends(require_project_member_csrf),
    db: Session = Depends(get_db),
) -> dict[str, str | None]:
    item = _resolve_pdf_item(
        db, project_id, payload, admin, import_batch_id=import_batch_id
    )
    return {"status": item.status.value, "documentId": item.attached_document_id}


@router.post("/projects/{project_id}/pdf-matches/resolve")
def resolve_project_pdf_match(
    project_id: str,
    payload: PdfMatchResolve,
    admin: User = Depends(require_project_member_csrf),
    db: Session = Depends(get_db),
) -> dict[str, str | None]:
    item = _resolve_pdf_item(db, project_id, payload, admin)
    return {"status": item.status.value, "documentId": item.attached_document_id}


@router.post("/projects/{project_id}/imports/preview")
async def preview_import(
    project_id: str,
    file: UploadFile = File(...),
    admin: User = Depends(require_project_member_csrf),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    from app.imports.adapters import normalize_imported_row, parse_file

    safe_name = Path(file.filename or "import").name
    suffix = Path(safe_name).suffix.lower()
    if suffix not in {".csv", ".tsv", ".xlsx", ".ris", ".bib", ".bibtex"}:
        raise UnsupportedMediaError("Unsupported import format")
    settings = get_settings()
    chunks: list[bytes] = []
    total = 0
    try:
        while chunk := await file.read(1024 * 1024):
            total += len(chunk)
            if total > settings.max_upload_bytes:
                raise PayloadTooLargeError(
                    f"Import file exceeds the {settings.max_upload_bytes}-byte limit"
                )
            chunks.append(chunk)
    finally:
        await file.close()
    rows = parse_file(safe_name, b"".join(chunks))
    fields = sorted({str(key) for row in rows for key in row})
    normalized = [normalize_imported_row(row) for row in rows[:10]]
    return {
        "filename": safe_name,
        "recordCount": len(rows),
        "detectedFields": fields,
        "previewRows": rows[:10],
        "normalizedPreview": normalized,
    }
