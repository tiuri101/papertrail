from __future__ import annotations

from collections import Counter
from datetime import datetime, timezone

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.errors import ConflictError, DomainError, NotFoundError
from app.conflicts.models import FinalDecision
from app.projects.models import Project, ProjectStage, ResolutionMethod, ScreeningConfig, ScreeningStage
from app.publications.models import Publication
from app.screening.models import ScreeningDecision, ScreeningOutcome, ScreeningWorkItem
from app.screening.service import current_decisions, decisions_visible, eligible_reviewer_ids


def valid_final_decision(db: Session, publication_id: str, stage: ScreeningStage) -> FinalDecision | None:
    return db.scalar(
        select(FinalDecision)
        .where(
            FinalDecision.publication_id == publication_id,
            FinalDecision.stage == stage,
            FinalDecision.is_valid.is_(True),
        )
        .order_by(FinalDecision.created_at.desc())
    )


def invalidate_final_decisions(
    db: Session,
    publication_id: str,
    stage: ScreeningStage,
    reason: str = "Reviewer decision revised",
) -> int:
    decisions = list(
        db.scalars(
            select(FinalDecision).where(
                FinalDecision.publication_id == publication_id,
                FinalDecision.stage == stage,
                FinalDecision.is_valid.is_(True),
            )
        )
    )
    now = datetime.now(timezone.utc)
    for final in decisions:
        final.is_valid = False
        final.invalidated_at = now
        final.invalidation_reason = reason
    db.flush()
    return len(decisions)


def record_final_decision(
    db: Session,
    publication_id: str,
    stage: ScreeningStage,
    outcome: str | ScreeningOutcome,
    resolution_method: str,
    resolved_by_id: str | None,
    note: str | None,
) -> FinalDecision:
    publication = db.get(Publication, publication_id)
    if publication is None:
        raise NotFoundError("Publication not found")
    invalidate_final_decisions(db, publication_id, stage, "Replaced by a newer final decision")
    final = FinalDecision(
        project_id=publication.project_id,
        publication_id=publication_id,
        stage=stage,
        outcome=ScreeningOutcome(outcome),
        resolution_method=resolution_method,
        resolved_by_id=resolved_by_id,
        note=note,
        is_valid=True,
    )
    db.add(final)
    db.flush()
    return final


def refresh_automatic_final_decision(
    db: Session,
    publication_id: str,
    stage: ScreeningStage,
) -> FinalDecision | None:
    if not decisions_visible(db, publication_id, stage):
        return None
    decisions = current_decisions(db, publication_id, stage)
    outcomes = [decision.outcome for decision in decisions]
    if any(outcome == ScreeningOutcome.UNCERTAIN for outcome in outcomes):
        return None
    existing = valid_final_decision(db, publication_id, stage)
    if len(set(outcomes)) == 1:
        if existing and existing.outcome == outcomes[0] and existing.resolution_method == "agreement":
            return existing
        return record_final_decision(db, publication_id, stage, outcomes[0], "agreement", None, None)

    publication = db.get(Publication, publication_id)
    assert publication is not None
    config = db.scalar(
        select(ScreeningConfig).where(
            ScreeningConfig.project_id == publication.project_id,
            ScreeningConfig.stage == stage,
        )
    )
    if config and config.conflict_resolution == ResolutionMethod.MAJORITY:
        counts = Counter(outcomes)
        ordered = counts.most_common()
        if len(ordered) == 1 or (len(ordered) > 1 and ordered[0][1] > ordered[1][1]):
            return record_final_decision(
                db,
                publication_id,
                stage,
                ordered[0][0],
                "majority",
                None,
                None,
            )
    return None


def unresolved_publication_ids(db: Session, project_id: str, stage: ScreeningStage) -> list[str]:
    publication_ids = list(
        db.scalars(
            select(Publication.id).where(
                Publication.project_id == project_id,
                Publication.is_active.is_(True),
                Publication.merged_into_id.is_(None),
            )
        )
    )
    result = []
    for publication_id in publication_ids:
        refresh_automatic_final_decision(db, publication_id, stage)
        if valid_final_decision(db, publication_id, stage) is None:
            result.append(publication_id)
    db.flush()
    return result


def add_resolution_reviewer(
    db: Session,
    publication_id: str,
    stage: ScreeningStage,
) -> ScreeningWorkItem:
    publication = db.get(Publication, publication_id)
    if publication is None:
        raise NotFoundError("Publication not found")
    existing_reviewers = set(
        db.scalars(
            select(ScreeningWorkItem.assigned_reviewer_id).where(
                ScreeningWorkItem.publication_id == publication_id,
                ScreeningWorkItem.stage == stage,
                ScreeningWorkItem.assigned_reviewer_id.is_not(None),
            )
        )
    )
    candidates = [
        reviewer_id
        for reviewer_id in eligible_reviewer_ids(db, publication.project_id, stage)
        if reviewer_id not in existing_reviewers
    ]
    if not candidates:
        raise ConflictError("No additional eligible reviewer is available")
    max_slot = db.scalar(
        select(func.coalesce(func.max(ScreeningWorkItem.slot_number), 0)).where(
            ScreeningWorkItem.publication_id == publication_id,
            ScreeningWorkItem.stage == stage,
        )
    ) or 0
    from app.screening.service import rank_for
    project = db.get(Project, publication.project_id)
    assert project is not None
    item = ScreeningWorkItem(
        project_id=publication.project_id,
        publication_id=publication_id,
        stage=stage,
        slot_number=max_slot + 1,
        assigned_reviewer_id=candidates[0],
        random_rank=rank_for(project, publication_id, stage),
    )
    db.add(item)
    db.flush()
    return item


def transition_if_screening_complete(
    db: Session,
    project: Project,
    stage: ScreeningStage,
) -> bool:
    unresolved = unresolved_publication_ids(db, project.id, stage)
    if unresolved:
        return False
    if stage == ScreeningStage.TITLE_ABSTRACT:
        project.stage = ProjectStage.FULL_TEXT
        from app.fulltext.service import initialize_full_text_stage
        initialize_full_text_stage(db, project)
    elif stage == ScreeningStage.FULL_TEXT:
        from app.fulltext.service import transition_if_full_text_complete
        return transition_if_full_text_complete(db, project)
    else:
        raise DomainError("Unsupported screening stage")
    db.flush()
    return True
