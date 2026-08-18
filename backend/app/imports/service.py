from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from sqlalchemy import delete, distinct, exists, select
from sqlalchemy.orm import Session

from app.imports.adapters import normalize_imported_row, parse_file
from app.imports.models import ImportBatch, ImportedRecord, ImportStatus, SearchSource
from app.jobs.models import BackgroundJob


def process_import_job(db: Session, job: BackgroundJob) -> dict[str, object]:
    batch = db.get(ImportBatch, job.payload["import_batch_id"])
    if batch is None:
        raise ValueError("Import batch no longer exists")
    batch.status = ImportStatus.PROCESSING
    db.commit()
    data = Path(batch.stored_path).read_bytes()
    rows = parse_file(batch.original_filename, data)
    batch.record_count = len(rows)
    job.progress_total = len(rows)
    db.commit()
    for index, row in enumerate(rows, start=1):
        parsed = normalize_imported_row(row, batch.mapping)
        warnings: list[str] = []
        state = "valid"
        if not parsed.get("title"):
            warnings.append("Missing title")
            state = "invalid"
            batch.invalid_record_count += 1
        db.add(
            ImportedRecord(
                import_batch_id=batch.id,
                source_row=index + 1,
                source_key=(
                    str(row.get("source_key")) if row.get("source_key") else None
                ),
                raw_data={str(k): v for k, v in row.items()},
                parsed_data=parsed,
                validation_state=state,
                warnings=warnings,
            )
        )
        job.progress_current = index
        if index % 100 == 0:
            db.commit()
    batch.status = ImportStatus.COMPLETED
    batch.completed_at = datetime.now(UTC)
    db.commit()
    from app.publications.service import normalize_imported_records

    normalized = normalize_imported_records(db, batch.id)
    db.commit()
    from app.imports.pdf_import import process_pdf_matches

    pdfs = process_pdf_matches(db, batch)
    return {
        "importBatchId": batch.id,
        "records": len(rows),
        "invalid": batch.invalid_record_count,
        "normalized": normalized,
        "pdfs": pdfs,
    }


def _screened_publication_ids(db: Session, publication_ids: list[str]) -> set[str]:
    if not publication_ids:
        return set()
    from app.screening.models import ScreeningDecision, ScreeningWorkItem

    rows = db.scalars(
        select(distinct(ScreeningWorkItem.publication_id))
        .join(ScreeningDecision, ScreeningDecision.work_item_id == ScreeningWorkItem.id)
        .where(ScreeningWorkItem.publication_id.in_(publication_ids))
    ).all()
    return set(rows)


def preview_or_delete_search(
    db: Session, search: SearchSource, *, force: bool
) -> dict[str, Any]:
    """Delete a search and the papers it exclusively brought in.

    A publication is only removed if every one of its `PublicationSource`
    rows traces back to this search's import batches -- one that duplicate
    review also merged in from another search stays untouched, just losing
    this search's source record. Unless `force=True`, nothing is deleted --
    this only reports what *would* happen (including how many of those
    papers have already been screened) so the UI can confirm first.
    """
    from app.publications.models import Publication, PublicationSource

    batch_ids = [batch.id for batch in search.import_batches]
    publications_to_delete: list[Publication] = []
    record_ids_subq = select(ImportedRecord.id).where(
        ImportedRecord.import_batch_id.in_(batch_ids)
    )
    if batch_ids:
        candidate_ids = db.scalars(
            select(distinct(PublicationSource.publication_id)).where(
                PublicationSource.imported_record_id.in_(record_ids_subq)
            )
        ).all()
        candidates = list(
            db.scalars(
                select(Publication).where(
                    Publication.id.in_(candidate_ids),
                    Publication.is_active.is_(True),
                )
            )
        )
        for publication in candidates:
            has_other_source = db.scalar(
                select(
                    exists().where(
                        PublicationSource.publication_id == publication.id,
                        PublicationSource.imported_record_id.not_in(record_ids_subq),
                    )
                )
            )
            if not has_other_source:
                publications_to_delete.append(publication)

    screened_ids = _screened_publication_ids(
        db, [publication.id for publication in publications_to_delete]
    )
    screened_publications = [
        publication
        for publication in publications_to_delete
        if publication.id in screened_ids
    ]

    if not force:
        return {
            "deleted": False,
            "requiresConfirmation": True,
            "publicationCount": len(publications_to_delete),
            "screenedPublicationCount": len(screened_publications),
            "screenedPublicationTitles": [
                publication.title for publication in screened_publications[:5]
            ],
        }

    for publication in publications_to_delete:
        publication.is_active = False
    if batch_ids:
        db.execute(
            delete(PublicationSource).where(
                PublicationSource.imported_record_id.in_(record_ids_subq)
            )
        )
    for batch in list(search.import_batches):
        stored_path = Path(batch.stored_path)
        db.delete(batch)
        stored_path.unlink(missing_ok=True)
    db.delete(search)

    return {
        "deleted": True,
        "requiresConfirmation": False,
        "publicationCount": len(publications_to_delete),
        "screenedPublicationCount": len(screened_publications),
    }
