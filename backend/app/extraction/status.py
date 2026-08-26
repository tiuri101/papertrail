"""A publication's extraction status, derived from the whole workflow.

An ``ExtractionWorkItem.status`` describes *one reviewer's slot*. In dual
extraction (``required_reviewers = 2``) a publication has two of them, and
neither one on its own says anything about the publication: slot 1 can read
``completed`` while slot 2 has not been claimed, while both slots can read
``completed`` and yet leave the publication with no authoritative result at
all because the two reviewers disagreed and reconciliation is still pending.

The authoritative "this publication's extraction is done" signal is therefore
never a slot status -- it is the existence of a current, valid
``FinalExtraction`` (``app.extraction.final``), which is created only by
single-reviewer submission, by agreement between both slots, by a completed
reconciliation, or by a manager override, and is invalidated whenever any of
those is superseded.

How many slots a publication *needs* is read from the slots it actually has
rather than from the project's current ``ExtractionConfig``: the slots were
generated once, from the configuration in force at the time, and nothing
regenerates them. Using the row count keeps the derivation correct for a
publication regardless of later configuration, and self-contained enough to
answer from data already loaded with the publication.
"""

from __future__ import annotations

import enum
from collections.abc import Sequence

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.extraction.models import ExtractionStatus, ExtractionWorkItem, FinalExtraction


class PublicationExtractionStatus(enum.StrEnum):
    """Where one publication stands in the extraction workflow."""

    #: Extraction has not been initialized for this publication -- it has no
    #: slots at all (e.g. it was never included at full text).
    NOT_STARTED = "not_started"
    #: Slots exist and none has been picked up yet.
    AVAILABLE = "available"
    #: At least one slot is reserved by a reviewer who has not submitted.
    IN_PROGRESS = "in_progress"
    #: Dual extraction: one reviewer is done, the other slot is still open.
    AWAITING_SECOND_REVIEWER = "awaiting_second_reviewer"
    #: Dual extraction: every slot is submitted but the reviewers disagreed,
    #: so a manager still has to reconcile them.
    AWAITING_RECONCILIATION = "awaiting_reconciliation"
    #: A current, valid FinalExtraction exists. The only "done" state.
    COMPLETED = "completed"


def derive_publication_extraction_status(
    slot_statuses: Sequence[ExtractionStatus | str],
    *,
    has_valid_final: bool,
) -> PublicationExtractionStatus:
    """The publication-level status for one publication's extraction slots."""
    if has_valid_final:
        return PublicationExtractionStatus.COMPLETED
    if not slot_statuses:
        return PublicationExtractionStatus.NOT_STARTED
    completed = sum(
        1 for status in slot_statuses if status == ExtractionStatus.COMPLETED
    )
    if completed == len(slot_statuses):
        # Every slot submitted, no authoritative result. With more than one
        # slot that is precisely the reconciliation queue's definition (see
        # app.extraction.reconciliation.reconciliation_queue). With a single
        # slot it should be unreachable -- submission finalizes immediately --
        # so report it as still in flight rather than inventing a
        # reconciliation that has nothing to reconcile.
        return (
            PublicationExtractionStatus.AWAITING_RECONCILIATION
            if len(slot_statuses) > 1
            else PublicationExtractionStatus.IN_PROGRESS
        )
    if completed:
        return PublicationExtractionStatus.AWAITING_SECOND_REVIEWER
    if any(status == ExtractionStatus.RESERVED for status in slot_statuses):
        return PublicationExtractionStatus.IN_PROGRESS
    return PublicationExtractionStatus.AVAILABLE


def publication_extraction_statuses(
    db: Session, publication_ids: Sequence[str]
) -> dict[str, PublicationExtractionStatus]:
    """The derived status of each given publication, in one pair of queries."""
    if not publication_ids:
        return {}
    slots: dict[str, list[ExtractionStatus]] = {
        publication_id: [] for publication_id in publication_ids
    }
    for publication_id, status in db.execute(
        select(ExtractionWorkItem.publication_id, ExtractionWorkItem.status).where(
            ExtractionWorkItem.publication_id.in_(publication_ids)
        )
    ):
        slots.setdefault(publication_id, []).append(status)
    finalized = set(
        db.scalars(
            select(FinalExtraction.publication_id).where(
                FinalExtraction.publication_id.in_(publication_ids),
                FinalExtraction.is_valid.is_(True),
            )
        )
    )
    return {
        publication_id: derive_publication_extraction_status(
            statuses, has_valid_final=publication_id in finalized
        )
        for publication_id, statuses in slots.items()
    }


def publication_extraction_status(
    db: Session, publication_id: str
) -> PublicationExtractionStatus:
    """The derived status of a single publication."""
    return publication_extraction_statuses(db, [publication_id])[publication_id]
