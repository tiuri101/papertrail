from __future__ import annotations

from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.conflicts.service import unresolved_publication_ids, valid_final_decision
from app.deduplication.models import DuplicateCandidate
from app.extraction.models import ExtractionStatus, ExtractionWorkItem
from app.fulltext.models import FullTextRetrieval, RetrievalStatus
from app.jobs.models import BackgroundJob, JobStatus
from app.llm.models import ProjectLlmSettings
from app.projects.models import (
    CriterionKind,
    Project,
    ProjectMembership,
    ProjectStage,
    ScreeningStage,
)
from app.publications.models import Publication
from app.quality.models import QualityConfig, QualityStatus, QualityWorkItem
from app.screening.models import ScreeningWorkItem, WorkItemStatus

STAGE_ORDER = [
    ProjectStage.DRAFT,
    ProjectStage.DUPLICATE_REVIEW,
    ProjectStage.TITLE_ABSTRACT,
    ProjectStage.FULL_TEXT,
    ProjectStage.EXTRACTION,
    ProjectStage.COMPLETED,
]

STAGE_LABELS = {
    ProjectStage.DRAFT: "Set Up the Project",
    ProjectStage.DUPLICATE_REVIEW: "Resolve Duplicates",
    ProjectStage.TITLE_ABSTRACT: "Title/Abstract Screening",
    ProjectStage.FULL_TEXT: "Full-Text Retrieval and Screening",
    ProjectStage.EXTRACTION: "Data Extraction and Quality Assessment",
    ProjectStage.COMPLETED: "Completed",
}

STAGE_AUTO_ADVANCES = {
    ProjectStage.DUPLICATE_REVIEW,
    ProjectStage.TITLE_ABSTRACT,
    ProjectStage.FULL_TEXT,
    ProjectStage.EXTRACTION,
}

STAGE_ACTIONS = {
    ProjectStage.DRAFT: "ready",
}


def _item(key: str, label: str, done: bool, detail: str) -> dict[str, Any]:
    return {"key": key, "label": label, "done": done, "detail": detail}


def _count(db: Session, *clauses: Any) -> int:
    return db.scalar(select(func.count()).select_from(Publication).where(*clauses)) or 0


def _draft_items(
    db: Session, project: Project, user_id: str | None
) -> list[dict[str, Any]]:
    rq_count = sum(1 for item in project.research_questions if item.is_active)
    inclusion_count = sum(
        1
        for item in project.criteria
        if item.is_active and item.kind == CriterionKind.INCLUSION
    )
    exclusion_count = sum(
        1
        for item in project.criteria
        if item.is_active and item.kind == CriterionKind.EXCLUSION
    )
    publication_count = _count(
        db, Publication.project_id == project.id, Publication.is_active.is_(True)
    )
    reviewer_count = (
        db.scalar(
            select(func.count())
            .select_from(ProjectMembership)
            .where(ProjectMembership.project_id == project.id)
        )
        or 0
    )
    return [
        _item(
            "research_questions",
            "Add at least one research question",
            rq_count > 0,
            f"{rq_count} added",
        ),
        _item(
            "criteria",
            "Add at least one inclusion and one exclusion criterion",
            inclusion_count > 0 and exclusion_count > 0,
            f"{inclusion_count} inclusion, {exclusion_count} exclusion",
        ),
        _item(
            "publications",
            "Import publications to review",
            publication_count > 0,
            f"{publication_count} imported",
        ),
        _item(
            "reviewers",
            "Assign at least one reviewer",
            reviewer_count > 0,
            f"{reviewer_count} assigned",
        ),
    ]


def _duplicate_review_items(
    db: Session, project: Project, user_id: str | None
) -> list[dict[str, Any]]:
    latest_job = db.scalar(
        select(BackgroundJob)
        .where(
            BackgroundJob.project_id == project.id,
            BackgroundJob.job_type == "detect_duplicates",
        )
        .order_by(BackgroundJob.created_at.desc())
        .limit(1)
    )
    detection_done = latest_job is not None and latest_job.status == JobStatus.COMPLETED
    total = (
        db.scalar(
            select(func.count())
            .select_from(DuplicateCandidate)
            .where(DuplicateCandidate.project_id == project.id)
        )
        or 0
    )
    unresolved = (
        db.scalar(
            select(func.count())
            .select_from(DuplicateCandidate)
            .where(
                DuplicateCandidate.project_id == project.id,
                DuplicateCandidate.status == "unresolved",
            )
        )
        or 0
    )
    resolved = total - unresolved
    return [
        _item(
            "detection",
            "Detect duplicate publications",
            detection_done,
            "Detection complete" if detection_done else "Running…",
        ),
        _item(
            "resolve_duplicates",
            "Resolve every duplicate candidate",
            unresolved == 0,
            f"{resolved} of {total} resolved",
        ),
    ]


def _my_open_work_item_count(
    db: Session,
    model: Any,
    project_id: str,
    user_id: str | None,
    *,
    extra_clauses: tuple[Any, ...] = (),
) -> int:
    if not user_id:
        return 0
    open_status = {
        ScreeningWorkItem: WorkItemStatus.SUBMITTED,
        ExtractionWorkItem: ExtractionStatus.COMPLETED,
        QualityWorkItem: QualityStatus.COMPLETED,
    }[model]
    return (
        db.scalar(
            select(func.count())
            .select_from(model)
            .where(
                model.project_id == project_id,
                model.assigned_reviewer_id == user_id,
                model.status != open_status,
                *extra_clauses,
            )
        )
        or 0
    )


def _title_abstract_items(
    db: Session, project: Project, user_id: str | None
) -> list[dict[str, Any]]:
    unresolved = len(
        unresolved_publication_ids(db, project.id, ScreeningStage.TITLE_ABSTRACT)
    )
    my_open = _my_open_work_item_count(
        db,
        ScreeningWorkItem,
        project.id,
        user_id,
        extra_clauses=(ScreeningWorkItem.stage == ScreeningStage.TITLE_ABSTRACT,),
    )
    return [
        _item(
            "title_abstract_decisions",
            "Reach a final include/exclude decision for every publication",
            unresolved == 0,
            f"{my_open} awaiting your decision ({unresolved} open in total)",
        ),
    ]


def _full_text_items(
    db: Session, project: Project, user_id: str | None
) -> list[dict[str, Any]]:
    from app.extraction.service import project_form

    retrievals = list(
        db.scalars(
            select(FullTextRetrieval).where(FullTextRetrieval.project_id == project.id)
        )
    )
    total = len(retrievals)
    retrieved = sum(
        1
        for retrieval in retrievals
        if retrieval.status
        not in {RetrievalStatus.NOT_YET_SOUGHT, RetrievalStatus.REQUESTED}
    )
    available = [
        retrieval
        for retrieval in retrievals
        if retrieval.status == RetrievalStatus.AVAILABLE
    ]
    decided = sum(
        1
        for retrieval in available
        if valid_final_decision(db, retrieval.publication_id, ScreeningStage.FULL_TEXT)
        is not None
    )
    has_extraction_form = project_form(db, project.id) is not None
    my_open = _my_open_work_item_count(
        db,
        ScreeningWorkItem,
        project.id,
        user_id,
        extra_clauses=(ScreeningWorkItem.stage == ScreeningStage.FULL_TEXT,),
    )
    return [
        _item(
            "full_text_retrieval",
            "Resolve full-text retrieval for every included publication",
            retrieved == total,
            f"{retrieved} of {total} resolved",
        ),
        _item(
            "full_text_decisions",
            "Screen every retrieved full text",
            decided == len(available),
            f"{my_open} awaiting your decision ({len(available) - decided} open in total)",
        ),
        _item(
            "extraction_form",
            "Create the data extraction form",
            has_extraction_form,
            "Extraction form created" if has_extraction_form else "Not created yet",
        ),
    ]


def _extraction_items(
    db: Session, project: Project, user_id: str | None
) -> list[dict[str, Any]]:
    extraction_total = (
        db.scalar(
            select(func.count())
            .select_from(ExtractionWorkItem)
            .where(ExtractionWorkItem.project_id == project.id)
        )
        or 0
    )
    extraction_done = (
        db.scalar(
            select(func.count())
            .select_from(ExtractionWorkItem)
            .where(
                ExtractionWorkItem.project_id == project.id,
                ExtractionWorkItem.status == ExtractionStatus.COMPLETED,
            )
        )
        or 0
    )
    my_open = _my_open_work_item_count(db, ExtractionWorkItem, project.id, user_id)
    items = [
        _item(
            "extraction",
            "Complete data extraction for every included publication",
            extraction_done == extraction_total,
            f"{my_open} awaiting your extraction "
            f"({extraction_total - extraction_done} open in total)",
        ),
    ]
    llm_settings = db.scalar(
        select(ProjectLlmSettings).where(ProjectLlmSettings.project_id == project.id)
    )
    if llm_settings is not None and llm_settings.extraction_validation_enabled:
        from app.llm.task_service import project_validation_progress

        validation = project_validation_progress(db, project.id)
        details = [f"{validation.completed} of {validation.total} validated"]
        if validation.pending:
            details.append(f"{validation.pending} processing")
        if validation.failed:
            details.append(f"{validation.failed} failed")
        if validation.unavailable:
            details.append(f"{validation.unavailable} unavailable")
        items.append(
            _item(
                "llm_extraction_validation",
                "Complete LLM validation of the human extractions",
                validation.settled,
                ", ".join(details),
            )
        )
    config = db.scalar(
        select(QualityConfig).where(QualityConfig.project_id == project.id)
    )
    if config is not None and config.enabled:
        quality_total = (
            db.scalar(
                select(func.count())
                .select_from(QualityWorkItem)
                .where(QualityWorkItem.project_id == project.id)
            )
            or 0
        )
        quality_done = (
            db.scalar(
                select(func.count())
                .select_from(QualityWorkItem)
                .where(
                    QualityWorkItem.project_id == project.id,
                    QualityWorkItem.status == QualityStatus.COMPLETED,
                )
            )
            or 0
        )
        my_open_quality = _my_open_work_item_count(
            db, QualityWorkItem, project.id, user_id
        )
        items.append(
            _item(
                "quality",
                "Complete quality assessment for every included publication",
                quality_done == quality_total,
                f"{my_open_quality} awaiting your assessment "
                f"({quality_total - quality_done} open in total)",
            )
        )
    return items


STAGE_BUILDERS = {
    ProjectStage.DRAFT: _draft_items,
    ProjectStage.DUPLICATE_REVIEW: _duplicate_review_items,
    ProjectStage.TITLE_ABSTRACT: _title_abstract_items,
    ProjectStage.FULL_TEXT: _full_text_items,
    ProjectStage.EXTRACTION: _extraction_items,
}


def project_checklist(
    db: Session, project: Project, user_id: str | None = None
) -> dict[str, Any]:
    current_index = STAGE_ORDER.index(project.stage)
    stages = []
    for index, stage in enumerate(STAGE_ORDER):
        builder = STAGE_BUILDERS.get(stage)
        items = builder(db, project, user_id) if builder else []
        is_complete = index < current_index or (
            stage == ProjectStage.COMPLETED and project.stage == ProjectStage.COMPLETED
        )
        stages.append(
            {
                "stage": stage.value,
                "label": STAGE_LABELS[stage],
                "is_current": stage == project.stage,
                "is_complete": is_complete,
                "items": items,
                "auto_advances": stage in STAGE_AUTO_ADVANCES,
                "action": STAGE_ACTIONS.get(stage),
            }
        )
    return {"stage": project.stage.value, "stages": stages}
