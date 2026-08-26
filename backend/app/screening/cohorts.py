"""Canonical publication-cohort queries.

Whether a publication is "title/abstract included" or "full-text included" is a
single domain rule -- a valid FinalDecision at that stage with outcome INCLUDE,
*on a publication that is still part of the review*. Extraction, quality,
project lifecycle, reporting, and LLM eligibility all need this exact cohort
and must never reimplement the filter independently, or they risk silently
disagreeing about which publications are in scope.

Both halves of that rule live here, and only here:

* ``FinalDecision.is_valid`` -- a superseded verdict is history, not the
  current one (see ``app.conflicts.service``);
* ``Publication.is_active`` -- a publication removed from the review (deleted,
  or merged away into a canonical record) is no longer evidence, whatever
  decision it once received. See ``app.publications.deletion`` for what
  removal means and why the check belongs here rather than being repeated at
  every consumer.

Scattering the second check across consumers is exactly how they drifted
apart before: hiding a deleted publication from the Publications list while
extraction, reporting, PRISMA counts and project completion all kept counting
it.
"""

from __future__ import annotations

from sqlalchemy import ColumnElement, and_, exists, func, select
from sqlalchemy.orm import Session

from app.conflicts.models import FinalDecision
from app.projects.models import ScreeningStage
from app.publications.models import Publication
from app.screening.models import ScreeningOutcome


def on_active_publication() -> ColumnElement[bool]:
    """Restrict a FinalDecision query to publications still in the review.

    A correlated EXISTS rather than a join, so it can be dropped into any
    query already selecting from ``final_decisions`` -- including the ones
    that select a single column or a COUNT -- without changing their shape.
    Exposed for the few call sites that build their own FinalDecision
    aggregate (project progress statistics) and must agree with the cohorts
    below.
    """
    return exists().where(
        Publication.id == FinalDecision.publication_id,
        Publication.is_active.is_(True),
    )


def outcome_filter(
    project_id: str, stage: ScreeningStage, outcome: ScreeningOutcome
) -> ColumnElement[bool]:
    return and_(
        FinalDecision.project_id == project_id,
        FinalDecision.stage == stage,
        FinalDecision.outcome == outcome,
        FinalDecision.is_valid.is_(True),
        on_active_publication(),
    )


def outcome_filter_any_stage(
    project_id: str, outcome: ScreeningOutcome
) -> ColumnElement[bool]:
    """Like outcome_filter, but not scoped to a single screening stage -- for
    callers answering "how many valid decisions across the whole project have
    this outcome" (e.g. a project-wide uncertain count, or an "excluded at
    either stage" export scope) rather than the per-stage inclusion cohort."""
    return and_(
        FinalDecision.project_id == project_id,
        FinalDecision.outcome == outcome,
        FinalDecision.is_valid.is_(True),
        on_active_publication(),
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
                on_active_publication(),
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
                on_active_publication(),
            )
        )
    )


def decided_ids_for_stage(
    db: Session, project_id: str, stage: ScreeningStage
) -> list[str]:
    """Publications with any valid FinalDecision at `stage`, regardless of
    outcome -- "has this stage been decided", not "was it decided INCLUDE"."""
    return list(
        db.scalars(
            select(FinalDecision.publication_id).where(
                FinalDecision.project_id == project_id,
                FinalDecision.stage == stage,
                FinalDecision.is_valid.is_(True),
                on_active_publication(),
            )
        )
    )


def decided_final_decisions_by_publication(
    db: Session,
    project_id: str,
    stage: ScreeningStage,
    publication_ids: list[str] | None = None,
) -> dict[str, FinalDecision]:
    """Same cohort as decided_final_decisions, indexed by publication_id --
    for callers that need to look up individual publications' decisions
    rather than iterate every row. Optionally scoped to a subset of
    publication ids to avoid pulling every valid decision at this stage."""
    if publication_ids is not None and not publication_ids:
        return {}
    conditions = [
        FinalDecision.project_id == project_id,
        FinalDecision.stage == stage,
        FinalDecision.is_valid.is_(True),
        on_active_publication(),
    ]
    if publication_ids is not None:
        conditions.append(FinalDecision.publication_id.in_(publication_ids))
    rows = db.scalars(select(FinalDecision).where(*conditions))
    return {row.publication_id: row for row in rows}


def title_abstract_included_ids(db: Session, project_id: str) -> list[str]:
    return publication_ids_for_outcome(
        db, project_id, ScreeningStage.TITLE_ABSTRACT, ScreeningOutcome.INCLUDE
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
