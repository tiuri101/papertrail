"""Retrying a partially completed import must not duplicate or double-count.

The parse job commits every 100 rows, so any failure part-way through a batch
leaves committed work behind. Before these guards a retry restarted at row 1
and inserted every already-committed row a second time, and re-incremented the
batch's invalid-record counter on top of the value the first attempt had
already stored.
"""

from __future__ import annotations

from datetime import timedelta

import pytest
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

from app.accounts.service import create_user
from app.core.time import utcnow
from app.imports.adapters import normalize_imported_row
from app.imports.models import ImportBatch, ImportedRecord, ImportStatus
from app.jobs.models import BackgroundJob, JobStatus
from app.jobs.service import enqueue_job, restart_job
from app.jobs.worker import execute_next_job
from app.projects.models import Project, ReviewType
from app.publications.models import Publication, PublicationSource


def csv_with_rows(count: int, *, untitled_rows: frozenset[int] = frozenset()) -> bytes:
    lines = ["Title,Authors"]
    for number in range(1, count + 1):
        title = "" if number in untitled_rows else f"Paper {number}"
        lines.append(f"{title},Doe")
    return ("\n".join(lines) + "\n").encode()


def fail_on_row_titled(monkeypatch, title: str) -> None:
    """Blow up mid-batch, the way a transient parse/database fault would."""

    def guarded(row, mapping=None):
        parsed = normalize_imported_row(row, mapping)
        if parsed.get("title") == title:
            raise RuntimeError(f"simulated crash while parsing {title}")
        return parsed

    monkeypatch.setattr("app.imports.service.normalize_imported_row", guarded)


def queue_import(
    db,
    tmp_path,
    *,
    content: bytes,
    max_attempts: int = 3,
) -> tuple[str, str]:
    user = create_user(db, "importer", "Importer", "secret-password", is_admin=True)
    project = Project(
        name="Review", review_type=ReviewType.SYSTEMATIC_REVIEW, random_seed="seed"
    )
    db.add(project)
    db.flush()
    stored_path = tmp_path / "records.csv"
    stored_path.write_bytes(content)
    batch = ImportBatch(
        project_id=project.id,
        original_filename="records.csv",
        stored_path=str(stored_path),
        file_type="csv",
        status=ImportStatus.PENDING,
        created_by_id=user.id,
    )
    db.add(batch)
    db.flush()
    job = enqueue_job(
        db,
        "parse_import",
        {"import_batch_id": batch.id},
        project_id=project.id,
        created_by_id=user.id,
        max_attempts=max_attempts,
    )
    db.commit()
    return batch.id, job.id


def record_source_rows(db, batch_id: str) -> list[int | None]:
    return list(
        db.scalars(
            select(ImportedRecord.source_row)
            .where(ImportedRecord.import_batch_id == batch_id)
            .order_by(ImportedRecord.source_row)
        )
    )


def test_retrying_a_partially_committed_import_stores_each_row_once(
    db, session_factory, tmp_path, monkeypatch
) -> None:
    batch_id, job_id = queue_import(db, tmp_path, content=csv_with_rows(250))

    fail_on_row_titled(monkeypatch, "Paper 150")
    assert execute_next_job(session_factory, "test-worker") is True

    db.expire_all()
    # The commit-every-100 checkpoint means the first hundred rows survive the
    # failure; that committed work is exactly what a naive retry duplicated.
    assert len(record_source_rows(db, batch_id)) == 100
    assert db.get(BackgroundJob, job_id).status == JobStatus.QUEUED
    assert db.get(ImportBatch, batch_id).status == ImportStatus.PROCESSING

    monkeypatch.undo()
    assert execute_next_job(session_factory, "test-worker") is True

    db.expire_all()
    source_rows = record_source_rows(db, batch_id)
    assert len(source_rows) == 250
    assert len(set(source_rows)) == 250
    assert source_rows == list(range(2, 252))
    batch = db.get(ImportBatch, batch_id)
    assert batch.status == ImportStatus.COMPLETED
    assert batch.record_count == 250
    # One publication per source row, not two.
    assert (
        db.scalar(
            select(func.count())
            .select_from(Publication)
            .where(Publication.project_id == batch.project_id)
        )
        == 250
    )
    assert db.get(BackgroundJob, job_id).status == JobStatus.COMPLETED


def test_invalid_rows_before_a_failure_are_not_counted_twice(
    db, session_factory, tmp_path, monkeypatch
) -> None:
    batch_id, _ = queue_import(
        db,
        tmp_path,
        content=csv_with_rows(250, untitled_rows=frozenset({5, 10, 200})),
    )

    fail_on_row_titled(monkeypatch, "Paper 150")
    assert execute_next_job(session_factory, "test-worker") is True
    db.expire_all()
    # Two untitled rows are among the hundred the checkpoint committed. The
    # counter is a completion-time summary derived from stored records, so it
    # is not written until the batch actually completes -- which is precisely
    # why a retry cannot add to a half-finished tally.
    assert (
        db.scalar(
            select(func.count())
            .select_from(ImportedRecord)
            .where(
                ImportedRecord.import_batch_id == batch_id,
                ImportedRecord.validation_state == "invalid",
            )
        )
        == 2
    )
    assert db.get(ImportBatch, batch_id).invalid_record_count == 0

    monkeypatch.undo()
    assert execute_next_job(session_factory, "test-worker") is True

    db.expire_all()
    batch = db.get(ImportBatch, batch_id)
    assert batch.status == ImportStatus.COMPLETED
    # Three untitled rows in the file: three invalid records, counted once
    # each, no matter that rows 5 and 10 were seen by two attempts.
    assert batch.invalid_record_count == 3
    assert (
        db.scalar(
            select(func.count())
            .select_from(ImportedRecord)
            .where(
                ImportedRecord.import_batch_id == batch_id,
                ImportedRecord.validation_state == "invalid",
            )
        )
        == 3
    )


def test_an_import_whose_job_exhausts_its_retries_is_marked_failed(
    db, session_factory, tmp_path, monkeypatch
) -> None:
    batch_id, job_id = queue_import(
        db, tmp_path, content=csv_with_rows(10), max_attempts=1
    )

    fail_on_row_titled(monkeypatch, "Paper 3")
    assert execute_next_job(session_factory, "test-worker") is True

    db.expire_all()
    job = db.get(BackgroundJob, job_id)
    batch = db.get(ImportBatch, batch_id)
    assert job.status == JobStatus.FAILED
    # Batch state must not stay PROCESSING once the job has given up for good.
    assert batch.status == ImportStatus.FAILED
    assert "simulated crash" in (batch.error_message or "")


def test_a_restarted_import_completes_after_a_permanent_failure(
    db, session_factory, tmp_path, monkeypatch
) -> None:
    batch_id, job_id = queue_import(
        db, tmp_path, content=csv_with_rows(120), max_attempts=1
    )

    fail_on_row_titled(monkeypatch, "Paper 110")
    assert execute_next_job(session_factory, "test-worker") is True
    db.expire_all()
    assert db.get(ImportBatch, batch_id).status == ImportStatus.FAILED

    monkeypatch.undo()
    restart_job(db, db.get(BackgroundJob, job_id))
    db.commit()
    assert execute_next_job(session_factory, "test-worker") is True

    db.expire_all()
    batch = db.get(ImportBatch, batch_id)
    assert batch.status == ImportStatus.COMPLETED
    assert batch.error_message is None
    source_rows = record_source_rows(db, batch_id)
    assert source_rows == list(range(2, 122))
    assert (
        db.scalar(
            select(func.count())
            .select_from(PublicationSource)
            .join(
                ImportedRecord,
                ImportedRecord.id == PublicationSource.imported_record_id,
            )
            .where(ImportedRecord.import_batch_id == batch_id)
        )
        == 120
    )


def test_a_clean_import_larger_than_one_checkpoint_stores_every_row_once(
    db, session_factory, tmp_path
) -> None:
    """Positive case: the ordinary multi-checkpoint import still works."""
    batch_id, job_id = queue_import(db, tmp_path, content=csv_with_rows(205))

    assert execute_next_job(session_factory, "test-worker") is True

    db.expire_all()
    batch = db.get(ImportBatch, batch_id)
    assert batch.status == ImportStatus.COMPLETED
    assert batch.completed_at is not None
    assert batch.record_count == 205
    assert batch.invalid_record_count == 0
    assert record_source_rows(db, batch_id) == list(range(2, 207))
    job = db.get(BackgroundJob, job_id)
    assert job.status == JobStatus.COMPLETED
    assert job.result["records"] == 205
    assert job.progress_current == 205


def test_the_database_rejects_two_records_for_one_source_row(
    db, tmp_path
) -> None:
    """The invariant is enforced below the service too.

    Two workers can run the same job at once after a lease expiry, so the
    skip-what-is-already-there check in the service cannot be the only guard.
    """
    batch_id, _ = queue_import(db, tmp_path, content=csv_with_rows(1))
    for _ in range(2):
        db.add(
            ImportedRecord(
                import_batch_id=batch_id,
                source_row=2,
                raw_data={"title": "Paper 1"},
                parsed_data={"title": "Paper 1"},
                validation_state="valid",
                warnings=[],
            )
        )
    with pytest.raises(IntegrityError):
        db.flush()
    db.rollback()


def test_a_job_abandoned_by_a_dead_worker_fails_its_import_batch(
    db, session_factory, tmp_path
) -> None:
    """A worker killed mid-job never runs the failure path itself.

    Its row simply stays RUNNING with a lease nobody renews. Once no attempts
    are left nothing can claim it again, so without reaping, both the job and
    the ImportBatch behind it would stay "in progress" forever.
    """
    batch_id, job_id = queue_import(
        db, tmp_path, content=csv_with_rows(10), max_attempts=2
    )
    job = db.get(BackgroundJob, job_id)
    job.status = JobStatus.RUNNING
    job.attempts = 2
    job.locked_by = "worker-that-died"
    job.lease_until = utcnow() - timedelta(minutes=5)
    batch = db.get(ImportBatch, batch_id)
    batch.status = ImportStatus.PROCESSING
    db.commit()

    # No claimable work is left, but the abandoned job is still resolved.
    assert execute_next_job(session_factory, "test-worker") is False

    db.expire_all()
    job = db.get(BackgroundJob, job_id)
    assert job.status == JobStatus.FAILED
    assert job.completed_at is not None
    assert job.lease_until is None
    assert db.get(ImportBatch, batch_id).status == ImportStatus.FAILED


def test_a_still_leased_job_is_not_treated_as_abandoned(
    db, session_factory, tmp_path
) -> None:
    """Positive case: reaping must never touch a job that is simply running."""
    batch_id, job_id = queue_import(
        db, tmp_path, content=csv_with_rows(10), max_attempts=2
    )
    job = db.get(BackgroundJob, job_id)
    job.status = JobStatus.RUNNING
    job.attempts = 2
    job.locked_by = "busy-worker"
    job.lease_until = utcnow() + timedelta(minutes=5)
    db.get(ImportBatch, batch_id).status = ImportStatus.PROCESSING
    db.commit()

    assert execute_next_job(session_factory, "test-worker") is False

    db.expire_all()
    assert db.get(BackgroundJob, job_id).status == JobStatus.RUNNING
    assert db.get(ImportBatch, batch_id).status == ImportStatus.PROCESSING


def test_a_permanently_failed_job_never_retracts_a_completed_batch(
    db, session_factory, tmp_path, monkeypatch
) -> None:
    """Records that really were imported stay imported.

    The parse job also runs normalization and PDF matching after the batch is
    marked COMPLETED; a failure in that tail must not rewrite the batch as
    FAILED and hide records that exist.
    """
    batch_id, job_id = queue_import(
        db, tmp_path, content=csv_with_rows(3), max_attempts=1
    )

    def explode(db_session, batch):
        raise RuntimeError("PDF matching blew up")

    monkeypatch.setattr("app.imports.pdf_import.process_pdf_matches", explode)
    assert execute_next_job(session_factory, "test-worker") is True

    db.expire_all()
    assert db.get(BackgroundJob, job_id).status == JobStatus.FAILED
    batch = db.get(ImportBatch, batch_id)
    assert batch.status == ImportStatus.COMPLETED
    assert len(record_source_rows(db, batch_id)) == 3
