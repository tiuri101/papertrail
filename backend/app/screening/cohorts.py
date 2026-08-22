"""Canonical publication-cohort queries.

Whether a publication is "title/abstract included" or "full-text included" is a
single domain rule -- a valid FinalDecision at that stage with outcome INCLUDE.
Extraction, quality, project lifecycle, reporting, and LLM eligibility all need
this exact cohort and must never reimplement the filter independently, or they
risk silently disagreeing about which publications are in scope.
"""

from __future__ import annotations

from sqlalchemy import ColumnElement, and_, func, select
from sqlalchemy.orm import Session

from app.conflicts.models import FinalDecision
from app.projects.models import ScreeningStage
from app.screening.models import ScreeningOutcome


def outcome_filter(
    project_id: str, stage: ScreeningStage, outcome: ScreeningOutcome
) -> ColumnElement[bool]:
    return and_(
        FinalDecision.project_id == project_id,
        FinalDecision.stage == stage,
        FinalDecision.outcome == outcome,
        FinalDecision.is_valid.is_(True),
    )


def has_final_outcome(
    db: Session, publication_id: str, stage: ScreeningStage, outcome: ScreeningOutcome
) -> bool:
    """Whether a single publication has a valid FinalDecision at `stage`
    matching `outcome` -- the per-publication counterpart of
    publication_ids_for_outcome, for call sites checking one publication
    rather than listing a project's cohort."""
    return (
        db.scalar(
            select(FinalDecision.id).where(
                FinalDecision.publication_id == publication_id,
                FinalDecision.stage == stage,
                FinalDecision.outcome == outcome,
                FinalDecision.is_valid.is_(True),
            )
        )
        is not None
    )


def publication_ids_for_outcome(
    db: Session, project_id: str, stage: ScreeningStage, outcome: ScreeningOutcome
) -> list[str]:
    """Publications with a valid FinalDecision at `stage` matching `outcome`."""
    return list(
        db.scalars(
            select(FinalDecision.publication_id).where(
                outcome_filter(project_id, stage, outcome)
            )
        )
    )


def count_for_outcome(
    db: Session, project_id: str, stage: ScreeningStage, outcome: ScreeningOutcome
) -> int:
    """Same cohort as publication_ids_for_outcome, as a COUNT query -- for
    metrics/audit call sites that only need the size, not the ids."""
    return (
        db.scalar(
            select(func.count())
            .select_from(FinalDecision)
            .where(outcome_filter(project_id, stage, outcome))
        )
        or 0
    )


def decided_final_decisions(
    db: Session, project_id: str, stage: ScreeningStage
) -> list[FinalDecision]:
    """Every valid FinalDecision at `stage`, regardless of outcome -- for
    callers that need the decision rows themselves (e.g. to break outcomes
    down by count), not just the publication ids."""
    return list(
        db.scalars(
            select(FinalDecision).where(
                FinalDecision.project_id == project_id,
                FinalDecision.stage == stage,
                FinalDecision.is_valid.is_(True),
            )
        )
    )


def decided_ids_for_stage(db: Session, project_id: str, stage: ScreeningStage) -> list[str]:
    """Publications with any valid FinalDecision at `stage`, regardless of
    outcome -- "has this stage been decided", not "was it decided INCLUDE"."""
    return list(
        db.scalars(
            select(FinalDecision.publication_id).where(
                FinalDecision.project_id == project_id,
                FinalDecision.stage == stage,
                FinalDecision.is_valid.is_(True),
            )
        )
    )


def title_abstract_included_ids(db: Session, project_id: str) -> list[str]:
    return publication_ids_for_outcome(
        db, project_id, ScreeningStage.TITLE_ABSTRACT, ScreeningOutcome.INCLUDE
    )


def title_abstract_excluded_ids(db: Session, project_id: str) -> list[str]:
    return publication_ids_for_outcome(
        db, project_id, ScreeningStage.TITLE_ABSTRACT, ScreeningOutcome.EXCLUDE
    )


def full_text_included_ids(db: Session, project_id: str) -> list[str]:
    """Publications eligible for extraction/quality assessment/reporting:
    reached a valid INCLUDE decision at full-text screening."""
    return publication_ids_for_outcome(
        db, project_id, ScreeningStage.FULL_TEXT, ScreeningOutcome.INCLUDE
    )


def full_text_excluded_ids(db: Session, project_id: str) -> list[str]:
    return publication_ids_for_outcome(
        db, project_id, ScreeningStage.FULL_TEXT, ScreeningOutcome.EXCLUDE
    )
