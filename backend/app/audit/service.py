from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from sqlalchemy import Row, case, func, select
from sqlalchemy.orm import Session

from app.accounts.models import User
from app.audit.models import AuditEvent
from app.conflicts.models import FinalDecision
from app.conflicts.service import unresolved_publication_ids
from app.deduplication.models import DuplicateCandidate
from app.extraction.models import ExtractionStatus, ExtractionWorkItem
from app.fulltext.models import FullTextRetrieval, RetrievalStatus
from app.fulltext.service import full_text_screening_remaining
from app.jobs.models import BackgroundJob, JobStatus
from app.projects.models import Project, ScreeningStage
from app.publications.models import Publication
from app.quality.models import QualityStatus, QualityWorkItem
from app.screening.models import ScreeningOutcome, ScreeningWorkItem, WorkItemStatus


def record_audit(
    db: Session,
    *,
    action: str,
    entity_type: str,
    summary: str,
    actor_id: str | None = None,
    project_id: str | None = None,
    entity_id: str | None = None,
    metadata: dict[str, Any] | None = None,
) -> AuditEvent:
    event = AuditEvent(
        actor_id=actor_id,
        project_id=project_id,
        action=action,
        entity_type=entity_type,
        entity_id=entity_id,
        summary=summary,
        event_metadata=metadata or {},
    )
    db.add(event)
    db.flush()
    return event


def project_dashboard(db: Session, project_id: str) -> dict[str, int | str]:
    project = db.get(Project, project_id)
    if project is None:
        raise ValueError("Project not found")

    total_papers = (
        db.scalar(
            select(func.count())
            .select_from(Publication)
            .where(Publication.project_id == project_id)
        )
        or 0
    )
    papers_after_duplicate_review = (
        db.scalar(
            select(func.count())
            .select_from(Publication)
            .where(
                Publication.project_id == project_id, Publication.is_active.is_(True)
            )
        )
        or 0
    )
    papers_after_title_abstract_screening = (
        db.scalar(
            select(func.count())
            .select_from(FinalDecision)
            .where(
                FinalDecision.project_id == project_id,
                FinalDecision.stage == ScreeningStage.TITLE_ABSTRACT,
                FinalDecision.is_valid.is_(True),
                FinalDecision.outcome == ScreeningOutcome.INCLUDE,
            )
        )
        or 0
    )
    papers_after_full_text_screening = (
        db.scalar(
            select(func.count())
            .select_from(FinalDecision)
            .where(
                FinalDecision.project_id == project_id,
                FinalDecision.stage == ScreeningStage.FULL_TEXT,
                FinalDecision.is_valid.is_(True),
                FinalDecision.outcome == ScreeningOutcome.INCLUDE,
            )
        )
        or 0
    )
    unresolved_duplicates = (
        db.scalar(
            select(func.count())
            .select_from(DuplicateCandidate)
            .where(
                DuplicateCandidate.project_id == project_id,
                DuplicateCandidate.status == "unresolved",
            )
        )
        or 0
    )
    uncertain = (
        db.scalar(
            select(func.count())
            .select_from(FinalDecision)
            .where(
                FinalDecision.project_id == project_id,
                FinalDecision.is_valid.is_(True),
                FinalDecision.outcome == ScreeningOutcome.UNCERTAIN,
            )
        )
        or 0
    )
    reports_not_retrieved = (
        db.scalar(
            select(func.count())
            .select_from(FullTextRetrieval)
            .where(
                FullTextRetrieval.project_id == project_id,
                FullTextRetrieval.status.in_(
                    [RetrievalStatus.NOT_FOUND, RetrievalStatus.INACCESSIBLE]
                ),
            )
        )
        or 0
    )
    title_abstract_screening_remaining = len(
        unresolved_publication_ids(db, project_id, ScreeningStage.TITLE_ABSTRACT)
    )
    full_text_screening_remaining_count = full_text_screening_remaining(db, project_id)
    extraction_remaining = (
        db.scalar(
            select(func.count())
            .select_from(ExtractionWorkItem)
            .where(
                ExtractionWorkItem.project_id == project_id,
                ExtractionWorkItem.status != "completed",
            )
        )
        or 0
    )
    quality_remaining = (
        db.scalar(
            select(func.count())
            .select_from(QualityWorkItem)
            .where(
                QualityWorkItem.project_id == project_id,
                QualityWorkItem.status != "completed",
            )
        )
        or 0
    )
    failed_jobs = (
        db.scalar(
            select(func.count())
            .select_from(BackgroundJob)
            .where(
                BackgroundJob.project_id == project_id,
                BackgroundJob.status == JobStatus.FAILED,
            )
        )
        or 0
    )
    return {
        "stage": project.stage.value,
        "totalPapers": int(total_papers),
        "papersAfterDuplicateReview": int(papers_after_duplicate_review),
        "papersAfterTitleAbstractScreening": int(papers_after_title_abstract_screening),
        "papersAfterFullTextScreening": int(papers_after_full_text_screening),
        "unresolvedDuplicates": int(unresolved_duplicates),
        "uncertainDecisions": int(uncertain),
        "reportsNotRetrieved": int(reports_not_retrieved),
        "titleAbstractScreeningRemaining": int(title_abstract_screening_remaining),
        "fullTextScreeningRemaining": int(full_text_screening_remaining_count),
        "extractionRemaining": int(extraction_remaining),
        "qualityRemaining": int(quality_remaining),
        "failedJobs": int(failed_jobs),
    }


def reviewer_progress(db: Session, project_id: str) -> list[dict[str, Any]]:
    """Per-stage, per-reviewer work item counts: how many papers each
    reviewer has been assigned, and how many of those they've completed."""
    stages: list[dict[str, Any]] = []

    for stage, label in (
        (ScreeningStage.TITLE_ABSTRACT, "Title/Abstract Screening"),
        (ScreeningStage.FULL_TEXT, "Full-Text Screening"),
    ):
        rows = db.execute(
            select(
                ScreeningWorkItem.assigned_reviewer_id,
                User.display_name,
                func.count().label("assigned"),
                func.sum(
                    case(
                        (ScreeningWorkItem.status == WorkItemStatus.SUBMITTED, 1),
                        else_=0,
                    )
                ).label("completed"),
            )
            .join(User, User.id == ScreeningWorkItem.assigned_reviewer_id)
            .where(
                ScreeningWorkItem.project_id == project_id,
                ScreeningWorkItem.stage == stage,
            )
            .group_by(ScreeningWorkItem.assigned_reviewer_id, User.display_name)
            .order_by(User.display_name)
        ).all()
        stages.append(_reviewer_progress_stage(stage.value, label, rows))

    for model, completed_status, key, label in (
        (
            ExtractionWorkItem,
            ExtractionStatus.COMPLETED,
            "extraction",
            "Data Extraction",
        ),
        (QualityWorkItem, QualityStatus.COMPLETED, "quality", "Quality Assessment"),
    ):
        rows = db.execute(
            select(
                model.assigned_reviewer_id,
                User.display_name,
                func.count().label("assigned"),
                func.sum(case((model.status == completed_status, 1), else_=0)).label(
                    "completed"
                ),
            )
            .join(User, User.id == model.assigned_reviewer_id)
            .where(model.project_id == project_id)
            .group_by(model.assigned_reviewer_id, User.display_name)
            .order_by(User.display_name)
        ).all()
        stages.append(_reviewer_progress_stage(key, label, rows))

    return stages


def _reviewer_progress_stage(
    stage: str, label: str, rows: Sequence[Row[Any]]
) -> dict[str, Any]:
    return {
        "stage": stage,
        "label": label,
        "reviewers": [
            {
                "reviewerId": reviewer_id,
                "reviewerName": display_name,
                "assigned": int(assigned),
                "completed": int(completed or 0),
            }
            for reviewer_id, display_name, assigned, completed in rows
        ],
    }
