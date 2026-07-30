from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy.orm import Session

from app.imports.adapters import normalize_imported_row, parse_file
from app.imports.models import ImportBatch, ImportedRecord, ImportStatus
from app.jobs.models import BackgroundJob


def process_import_job(db: Session, job: BackgroundJob) -> dict[str, int | str]:
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
                source_key=str(row.get("source_key")) if row.get("source_key") else None,
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
    batch.completed_at = datetime.now(timezone.utc)
    db.commit()
    from app.publications.service import normalize_imported_records
    normalized = normalize_imported_records(db, batch.id)
    db.commit()
    return {"importBatchId": batch.id, "records": len(rows), "invalid": batch.invalid_record_count, "normalized": normalized}
