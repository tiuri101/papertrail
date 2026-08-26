from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from sqlalchemy import delete, distinct, exists, func, select
from sqlalchemy.orm import Session

from app.api.errors import NotFoundError
from app.imports.adapters import normalize_imported_row, parse_file
from app.imports.models import ImportBatch, ImportedRecord, ImportStatus, SearchSource
from app.jobs.models import BackgroundJob


def resolve_project_search_source(
    db: Session, project_id: str, search_source_id: str | None
) -> SearchSource | None:
    """Resolve a caller-supplied search-source id *within this project*.

    A `SearchSource` belongs to exactly one project, so accepting an id that
    merely exists would let a member of project A attribute an import batch
    to project B's documented search -- leaking that the search exists and
    corrupting B's PRISMA source accounting. A source belonging to another
    project is reported as simply not found, so the response can't be used to
    probe for ids outside the caller's own project.
    """
    if not search_source_id:
        return None
    source = db.get(SearchSource, search_source_id)
    if source is None or source.project_id != project_id:
        raise NotFoundError("Search source not found")
    return source


def _invalid_record_count(db: Session, import_batch_id: str) -> int:
    """Count the invalid records actually stored for a batch.

    Derived, never incremented: a retry that re-walks part of the file must
    not count the same bad row a second time.
    """
    return int(
        db.scalar(
            select(func.count())
            .select_from(ImportedRecord)
            .where(
                ImportedRecord.import_batch_id == import_batch_id,
                ImportedRecord.validation_state != "valid",
            )
        )
        or 0
    )


def _persisted_source_rows(db: Session, import_batch_id: str) -> set[int]:
    return {
        row
        for row in db.scalars(
            select(ImportedRecord.source_row).where(
                ImportedRecord.import_batch_id == import_batch_id,
                ImportedRecord.source_row.is_not(None),
            )
        )
        if row is not None
    }


def process_import_job(db: Session, job: BackgroundJob) -> dict[str, object]:
    """Parse one uploaded bibliographic file into immutable ImportedRecord rows.

    Retries are safe by construction rather than by cleaning up afterwards.
    Parsing is deterministic, so attempt N sees exactly the same rows in the
    same order as attempt 1 and a row's position in the file is a stable
    identity for that logical source row. Rows an earlier attempt already
    committed are skipped instead of inserted again, and the batch's counters
    are recomputed from what is actually stored instead of being incremented
    in memory. The (import_batch_id, source_row) unique constraint enforces
    the same invariant in the database, which additionally covers two workers
    executing the same job at once after a lease expiry.
    """
    batch = db.get(ImportBatch, job.payload["import_batch_id"])
    if batch is None:
        raise ValueError("Import batch no longer exists")
    batch.status = ImportStatus.PROCESSING
    batch.error_message = None
    db.commit()
    data = Path(batch.stored_path).read_bytes()
    rows = parse_file(batch.original_filename, data)
    batch.record_count = len(rows)
    job.progress_total = len(rows)
    db.commit()
    already_persisted = _persisted_source_rows(db, batch.id)
    for index, row in enumerate(rows, start=1):
        source_row = index + 1
        job.progress_current = index
        if source_row in already_persisted:
            continue
        parsed = normalize_imported_row(row, batch.mapping)
        warnings: list[str] = []
        state = "valid"
        if not parsed.get("title"):
            warnings.append("Missing title")
            state = "invalid"
        db.add(
            ImportedRecord(
                import_batch_id=batch.id,
                source_row=source_row,
                source_key=(
                    str(row.get("source_key")) if row.get("source_key") else None
                ),
                raw_data={str(k): v for k, v in row.items()},
                parsed_data=parsed,
                validation_state=state,
                warnings=warnings,
            )
        )
        if index % 100 == 0:
            db.commit()
    db.flush()
    batch.invalid_record_count = _invalid_record_count(db, batch.id)
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


def mark_import_permanently_failed(
    db: Session, job: BackgroundJob, error: str
) -> None:
    """Move the batch to FAILED once its parse job has given up for good.

    Registered as the ``parse_import`` permanent-failure hook so import state
    can never drift away from job state: without it an exhausted (or
    abandoned) parse job leaves its ImportBatch in PROCESSING forever and the
    UI reports a dead import as still running. A batch that already reached
    COMPLETED is left alone -- a later failure in the same job (PDF matching,
    say) does not retract records that are genuinely imported.
    """
    batch_id = job.payload.get("import_batch_id")
    if not batch_id:
        return
    batch = db.get(ImportBatch, str(batch_id))
    if batch is None or batch.status == ImportStatus.COMPLETED:
        return
    batch.status = ImportStatus.FAILED
    batch.error_message = error[:2000]
    db.flush()


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

    from app.publications.deletion import remove_publications_from_review

    remove_publications_from_review(db, search.project_id, publications_to_delete)
    if batch_ids:
        db.execute(
            delete(PublicationSource).where(
                PublicationSource.imported_record_id.in_(record_ids_subq)
            )
        )
    # The uploaded source files and PDF staging directories of these batches
    # are removed by the caller after it commits -- see
    # app.projects.file_cleanup for why deletion never precedes the commit.
    for batch in list(search.import_batches):
        db.delete(batch)
    db.delete(search)

    return {
        "deleted": True,
        "requiresConfirmation": False,
        "publicationCount": len(publications_to_delete),
        "screenedPublicationCount": len(screened_publications),
    }
