"""What "delete a publication" means for a review in progress.

Publications are never physically deleted: their row, their imported source
records, and every reviewer decision ever made about them stay, because an
imported record is immutable evidence of what a search returned and a
reviewer decision is a record of a judgement someone actually made.
``Publication.is_active = False`` is the flag that carries the deletion.

The semantic that flag denotes is **removal from the active review**, not
archival:

* the UI calls the action Delete and warns that it "cannot be undone"; there
  is no restore endpoint and never has been;
* the only other producer of ``is_active = False`` is a duplicate merge,
  which likewise means "this record is no longer one of the review's
  publications" (the canonical one is).

What that has to imply -- and, before this module existed, did not -- is that
a removed publication stops being *evidence*.  Deletion only hid it from the
Publications list; its ``FinalDecision`` rows stayed valid, so
:mod:`app.screening.cohorts` kept returning it as full-text included and
every downstream consumer built on those cohorts (extraction, quality,
analysis, reporting, PRISMA counts, project completion) kept treating a
publication no reviewer could see as included evidence.

The invariant is now enforced in two places, and only two:

1. :mod:`app.screening.cohorts` -- the canonical cohort queries exclude
   inactive publications, so every consumer that asks "which publications are
   included" gets a consistent answer without repeating the filter.  That is
   what makes reporting, analysis, completion and the LLM eligibility checks
   agree by construction.
2. this module -- open work that only exists *because* the publication was in
   the review is retracted here, so nothing is left stranded in a reviewer's
   queue or in a "still outstanding" counter pointing at a record that is
   gone.

Retraction deliberately removes only work nobody has acted on: an unsubmitted
work item, a full-text retrieval nobody completed, a queued LLM run, an
in-flight browser retrieval job.  Submitted decisions, completed extractions
and their responses are history and are kept -- they are simply no longer
part of any cohort.
"""

from __future__ import annotations

from collections.abc import Iterable

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.core.time import utcnow
from app.extraction.models import ExtractionResponse, ExtractionStatus, ExtractionWorkItem
from app.fulltext.models import FullTextRetrieval
from app.pdf_acquisition.models import (
    ACTIVE_JOB_STATUSES,
    PdfRetrievalJob,
    RetrievalJobStatus,
)
from app.publications.models import Publication
from app.quality.models import QualityResponse, QualityStatus, QualityWorkItem
from app.review_work.finalization import lock_publication_for_finalization
from app.screening.models import ScreeningDecision, ScreeningWorkItem, WorkItemStatus


def _retract_screening_work(db: Session, publication_id: str) -> int:
    """Drop screening slots nobody has submitted, at either stage."""
    decided_item_ids = select(ScreeningDecision.work_item_id).where(
        ScreeningDecision.work_item_id.in_(
            select(ScreeningWorkItem.id).where(
                ScreeningWorkItem.publication_id == publication_id
            )
        )
    )
    open_item_ids = list(
        db.scalars(
            select(ScreeningWorkItem.id).where(
                ScreeningWorkItem.publication_id == publication_id,
                ScreeningWorkItem.status != WorkItemStatus.SUBMITTED,
                ScreeningWorkItem.id.not_in(decided_item_ids),
            )
        )
    )
    if open_item_ids:
        db.execute(
            delete(ScreeningWorkItem).where(ScreeningWorkItem.id.in_(open_item_ids))
        )
    return len(open_item_ids)


def _retract_extraction_and_quality_work(db: Session, publication_id: str) -> int:
    """Drop extraction and quality slots nobody has filled in.

    A slot that already carries a response is left alone: the response is a
    reviewer's work, and ``get_current_final_extraction`` is still the only
    thing that decides what is authoritative -- which no longer matters for
    this publication because it has left every cohort.
    """
    answered_extraction_ids = select(ExtractionResponse.work_item_id).where(
        ExtractionResponse.work_item_id.in_(
            select(ExtractionWorkItem.id).where(
                ExtractionWorkItem.publication_id == publication_id
            )
        )
    )
    open_extraction_ids = list(
        db.scalars(
            select(ExtractionWorkItem.id).where(
                ExtractionWorkItem.publication_id == publication_id,
                ExtractionWorkItem.status != ExtractionStatus.COMPLETED,
                ExtractionWorkItem.id.not_in(answered_extraction_ids),
            )
        )
    )
    if open_extraction_ids:
        db.execute(
            delete(ExtractionWorkItem).where(
                ExtractionWorkItem.id.in_(open_extraction_ids)
            )
        )

    answered_quality_ids = select(QualityResponse.work_item_id).where(
        QualityResponse.work_item_id.in_(
            select(QualityWorkItem.id).where(
                QualityWorkItem.publication_id == publication_id
            )
        )
    )
    open_quality_ids = list(
        db.scalars(
            select(QualityWorkItem.id).where(
                QualityWorkItem.publication_id == publication_id,
                QualityWorkItem.status != QualityStatus.COMPLETED,
                QualityWorkItem.id.not_in(answered_quality_ids),
            )
        )
    )
    if open_quality_ids:
        db.execute(
            delete(QualityWorkItem).where(QualityWorkItem.id.in_(open_quality_ids))
        )
    return len(open_extraction_ids) + len(open_quality_ids)


def _retract_full_text_acquisition(db: Session, publication_id: str) -> int:
    """Cancel PDF acquisition for a publication that left the review.

    The ``FullTextRetrieval`` row is what makes a publication visible to the
    browser helper and what "PDFs still outstanding" counters are derived
    from, so it goes; any retrieval job an agent is holding is cancelled so
    the helper stops working on it and releases its lease.
    """
    now = utcnow()
    open_jobs = list(
        db.scalars(
            select(PdfRetrievalJob).where(
                PdfRetrievalJob.publication_id == publication_id,
                PdfRetrievalJob.status.in_(ACTIVE_JOB_STATUSES),
            )
        )
    )
    for job in open_jobs:
        job.status = RetrievalJobStatus.CANCELLED
        job.completed_at = now
        job.lease_until = None
    db.execute(
        delete(FullTextRetrieval).where(
            FullTextRetrieval.publication_id == publication_id
        )
    )
    return len(open_jobs)


def _settle_stage_after_removal(db: Session, project_id: str) -> None:
    """Let the project's stage catch up with the smaller cohort.

    Removing a publication can be the thing that finishes a stage: it may
    have been the last one without a decision, without a retrieved PDF, or
    without a completed extraction. Nothing else would notice -- stage
    transitions are driven by reviewer submissions, and a removal is not one
    -- so the project would sit in a stage with no outstanding work and no
    way to leave it. Each of these helpers checks the project's stage itself
    and is a no-op if the stage is not the one it owns.
    """
    from app.conflicts.service import transition_if_screening_complete
    from app.fulltext.service import transition_if_full_text_complete
    from app.projects.lifecycle import evaluate_project_completion
    from app.projects.models import Project, ProjectStage, ScreeningStage

    project = db.get(Project, project_id)
    if project is None:
        return
    if project.stage == ProjectStage.TITLE_ABSTRACT:
        transition_if_screening_complete(db, project, ScreeningStage.TITLE_ABSTRACT)
    elif project.stage == ProjectStage.FULL_TEXT:
        transition_if_full_text_complete(db, project)
    elif project.stage == ProjectStage.EXTRACTION:
        evaluate_project_completion(db, project)


def remove_publications_from_review(
    db: Session,
    project_id: str,
    publications: Iterable[Publication],
) -> int:
    """Take publications out of the active review and retract their open work.

    The single write path for ``Publication.is_active = False`` outside a
    duplicate merge (which has its own reversible bookkeeping). Callers
    record their own audit event; this owns the domain effects.

    Publications are processed in id order because each one is locked for the
    rest of the transaction, and two concurrent bulk deletes overlapping on
    the same publications must take those locks in the same order or they can
    deadlock against each other.
    """
    ordered = sorted(
        (
            publication
            for publication in publications
            if publication.project_id == project_id and publication.is_active
        ),
        key=lambda publication: publication.id,
    )
    for publication in ordered:
        lock_publication_for_finalization(db, publication.id)
        publication.is_active = False
        _retract_screening_work(db, publication.id)
        _retract_extraction_and_quality_work(db, publication.id)
        _retract_full_text_acquisition(db, publication.id)

        from app.llm.service import cancel_queued_for_publication

        cancel_queued_for_publication(db, publication.id)
    db.flush()
    if ordered:
        _settle_stage_after_removal(db, project_id)
    return len(ordered)
