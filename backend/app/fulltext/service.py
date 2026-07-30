from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.errors import DomainError
from app.conflicts.models import FinalDecision
from app.conflicts.service import valid_final_decision
from app.fulltext.models import FullTextRetrieval, RetrievalStatus
from app.projects.models import Project, ProjectStage, ScreeningStage
from app.screening.models import ScreeningOutcome, ScreeningWorkItem
from app.screening.service import create_screening_work_items


def title_abstract_included_ids(db: Session, project_id: str) -> list[str]:
    return list(
        db.scalars(
            select(FinalDecision.publication_id).where(
                FinalDecision.project_id == project_id,
                FinalDecision.stage == ScreeningStage.TITLE_ABSTRACT,
                FinalDecision.outcome == ScreeningOutcome.INCLUDE,
                FinalDecision.is_valid.is_(True),
            )
        )
    )


def initialize_full_text_stage(db: Session, project: Project) -> int:
    created = 0
    for publication_id in title_abstract_included_ids(db, project.id):
        existing = db.scalar(
            select(FullTextRetrieval.id).where(
                FullTextRetrieval.publication_id == publication_id
            )
        )
        if existing:
            continue
        db.add(FullTextRetrieval(project_id=project.id, publication_id=publication_id))
        created += 1
    db.flush()
    return created


def set_retrieval_status(
    db: Session,
    retrieval: FullTextRetrieval,
    status: RetrievalStatus,
    *,
    note: str | None = None,
    user_id: str | None = None,
) -> None:
    retrieval.status = status
    retrieval.note = note
    retrieval.updated_by_id = user_id
    if status == RetrievalStatus.AVAILABLE:
        project = db.get(Project, retrieval.project_id)
        assert project is not None
        create_screening_work_items(
            db,
            project,
            ScreeningStage.FULL_TEXT,
            publication_ids=[retrieval.publication_id],
        )
    elif status in {RetrievalStatus.NOT_FOUND, RetrievalStatus.INACCESSIBLE}:
        items = list(
            db.scalars(
                select(ScreeningWorkItem).where(
                    ScreeningWorkItem.publication_id == retrieval.publication_id,
                    ScreeningWorkItem.stage == ScreeningStage.FULL_TEXT,
                    ScreeningWorkItem.status != "submitted",
                )
            )
        )
        for item in items:
            db.delete(item)
    db.flush()


def transition_if_full_text_complete(db: Session, project: Project) -> bool:
    retrievals = list(
        db.scalars(
            select(FullTextRetrieval).where(FullTextRetrieval.project_id == project.id)
        )
    )
    expected = set(title_abstract_included_ids(db, project.id))
    if {item.publication_id for item in retrievals} != expected:
        return False
    for retrieval in retrievals:
        if retrieval.status in {
            RetrievalStatus.NOT_YET_SOUGHT,
            RetrievalStatus.REQUESTED,
        }:
            return False
        if retrieval.status == RetrievalStatus.AVAILABLE:
            final = valid_final_decision(
                db, retrieval.publication_id, ScreeningStage.FULL_TEXT
            )
            if final is None:
                return False
    project.stage = ProjectStage.EXTRACTION
    from app.extraction.service import initialize_extraction

    initialize_extraction(db, project)
    try:
        from app.quality.service import initialize_quality

        initialize_quality(db, project)
    except DomainError:
        raise
    db.flush()
    return True
