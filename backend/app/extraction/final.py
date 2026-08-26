"""The single authoritative source for "the current extraction result for a
publication".

Every other module that needs to know a publication's final, authoritative
extraction result must go through get_current_final_extraction(s) here
rather than querying ExtractionResponse.is_current or ExtractionWorkItem
directly -- those represent individual reviewer slots, not the authoritative
result (which, in dual-extraction mode, may require agreement or manual
reconciliation between two slots before it exists at all).
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.time import utcnow
from app.extraction.models import FinalExtraction
from app.review_work.finalization import lock_publication_for_finalization


def get_current_final_extraction(
    db: Session, publication_id: str
) -> FinalExtraction | None:
    return db.scalar(
        select(FinalExtraction)
        .where(
            FinalExtraction.publication_id == publication_id,
            FinalExtraction.is_valid.is_(True),
        )
        .order_by(FinalExtraction.created_at.desc())
    )


def get_current_final_extractions(
    db: Session, publication_ids: Sequence[str]
) -> dict[str, FinalExtraction]:
    if not publication_ids:
        return {}
    rows = db.scalars(
        select(FinalExtraction).where(
            FinalExtraction.publication_id.in_(publication_ids),
            FinalExtraction.is_valid.is_(True),
        )
    )
    return {row.publication_id: row for row in rows}


def invalidate_current_final_extraction(
    db: Session, publication_id: str, reason: str
) -> FinalExtraction | None:
    current = get_current_final_extraction(db, publication_id)
    if current is None:
        return None
    current.is_valid = False
    current.invalidated_at = utcnow()
    current.invalidation_reason = reason
    db.flush()
    return current


def create_or_replace_final_extraction(
    db: Session,
    *,
    project_id: str,
    publication_id: str,
    form_version_id: str,
    answers: dict[str, Any],
    resolution_method: str,
    resolved_by_id: str | None,
    note: str | None,
    field_provenance: dict[str, Any],
    contributing_response_ids: list[str],
    invalidation_reason: str = "Replaced by a newer final extraction",
) -> FinalExtraction:
    """The single write path for FinalExtraction: invalidate whatever is
    currently authoritative for this publication (if anything), then insert
    the new one, in one transaction. Reused by auto-finalization on
    agreement, reconciliation submission, revision-triggered recompute, and
    manager override.

    The invalidate-then-insert pair only produces "exactly one valid final
    extraction" if nothing interleaves between the two writes, so this
    serializes on the publication row first; the uq_final_extraction_current
    partial index is the backstop behind that lock, not the mechanism."""
    lock_publication_for_finalization(db, publication_id)
    invalidate_current_final_extraction(db, publication_id, invalidation_reason)
    final = FinalExtraction(
        project_id=project_id,
        publication_id=publication_id,
        form_version_id=form_version_id,
        answers=answers,
        resolution_method=resolution_method,
        resolved_by_id=resolved_by_id,
        note=note,
        field_provenance=field_provenance,
        contributing_response_ids=contributing_response_ids,
        is_valid=True,
    )
    db.add(final)
    db.flush()
    return final
