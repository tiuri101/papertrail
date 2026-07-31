from __future__ import annotations

from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.audit.models import AuditEvent
from app.conflicts.models import FinalDecision
from app.deduplication.models import DuplicateCandidate
from app.extraction.models import ExtractionWorkItem
from app.fulltext.models import FullTextRetrieval, RetrievalStatus
from app.jobs.models import BackgroundJob, JobStatus
from app.projects.models import Project, ScreeningStage
from app.publications.models import Publication
from app.quality.models import QualityWorkItem
from app.screening.models import ScreeningOutcome


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
        "extractionRemaining": int(extraction_remaining),
        "qualityRemaining": int(quality_remaining),
        "failedJobs": int(failed_jobs),
    }
