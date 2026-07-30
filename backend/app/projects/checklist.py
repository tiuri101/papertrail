from __future__ import annotations

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.conflicts.service import unresolved_publication_ids, valid_final_decision
from app.deduplication.models import DuplicateCandidate
from app.extraction.models import ExtractionStatus, ExtractionWorkItem
from app.fulltext.models import FullTextRetrieval, RetrievalStatus
from app.jobs.models import BackgroundJob, JobStatus
from app.projects.models import CriterionKind, Project, ProjectStage, ScreeningStage
from app.publications.models import Publication
from app.quality.models import QualityConfig, QualityStatus, QualityWorkItem

STAGE_ORDER = [
    ProjectStage.DRAFT,
    ProjectStage.DUPLICATE_REVIEW,
    ProjectStage.TITLE_ABSTRACT,
    ProjectStage.FULL_TEXT,
    ProjectStage.EXTRACTION,
    ProjectStage.COMPLETED,
]

STAGE_LABELS = {
    ProjectStage.DRAFT: "Set up the project",
    ProjectStage.DUPLICATE_REVIEW: "Resolve duplicates",
    ProjectStage.TITLE_ABSTRACT: "Title/abstract screening",
    ProjectStage.FULL_TEXT: "Full-text retrieval and screening",
    ProjectStage.EXTRACTION: "Data extraction and quality assessment",
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


def _item(key: str, label: str, done: bool, detail: str) -> dict:
    return {"key": key, "label": label, "done": done, "detail": detail}


def _count(db: Session, *clauses) -> int:
    return db.scalar(select(func.count()).select_from(Publication).where(*clauses)) or 0


def _draft_items(db: Session, project: Project) -> list[dict]:
    rq_count = sum(1 for item in project.research_questions if item.is_active)
    inclusion_count = sum(1 for item in project.criteria if item.is_active and item.kind == CriterionKind.INCLUSION)
    exclusion_count = sum(1 for item in project.criteria if item.is_active and item.kind == CriterionKind.EXCLUSION)
    publication_count = _count(db, Publication.project_id == project.id, Publication.is_active.is_(True))
    return [
        _item("research_questions", "Add at least one research question", rq_count > 0, f"{rq_count} added"),
        _item(
            "criteria",
            "Add at least one inclusion and one exclusion criterion",
            inclusion_count > 0 and exclusion_count > 0,
            f"{inclusion_count} inclusion, {exclusion_count} exclusion",
        ),
        _item("publications", "Import publications to review", publication_count > 0, f"{publication_count} imported"),
    ]


def _duplicate_review_items(db: Session, project: Project) -> list[dict]:
    latest_job = db.scalar(
        select(BackgroundJob)
        .where(BackgroundJob.project_id == project.id, BackgroundJob.job_type == "detect_duplicates")
        .order_by(BackgroundJob.created_at.desc())
        .limit(1)
    )
    detection_done = latest_job is not None and latest_job.status == JobStatus.COMPLETED
    total = db.scalar(select(func.count()).select_from(DuplicateCandidate).where(DuplicateCandidate.project_id == project.id)) or 0
    unresolved = db.scalar(
        select(func.count())
        .select_from(DuplicateCandidate)
        .where(DuplicateCandidate.project_id == project.id, DuplicateCandidate.status == "unresolved")
    ) or 0
    resolved = total - unresolved
    return [
        _item(
            "detection",
            "Detect duplicate publications",
            detection_done,
            "Detection complete" if detection_done else "Running…",
        ),
        _item("resolve_duplicates", "Resolve every duplicate candidate", unresolved == 0, f"{resolved} of {total} resolved"),
    ]


def _title_abstract_items(db: Session, project: Project) -> list[dict]:
    total = _count(db, Publication.project_id == project.id, Publication.is_active.is_(True), Publication.merged_into_id.is_(None))
    unresolved = len(unresolved_publication_ids(db, project.id, ScreeningStage.TITLE_ABSTRACT))
    decided = total - unresolved
    return [
        _item(
            "title_abstract_decisions",
            "Reach a final include/exclude decision for every publication",
            unresolved == 0,
            f"{decided} of {total} decided",
        ),
    ]


def _full_text_items(db: Session, project: Project) -> list[dict]:
    retrievals = list(db.scalars(select(FullTextRetrieval).where(FullTextRetrieval.project_id == project.id)))
    total = len(retrievals)
    retrieved = sum(1 for retrieval in retrievals if retrieval.status not in {RetrievalStatus.NOT_YET_SOUGHT, RetrievalStatus.REQUESTED})
    available = [retrieval for retrieval in retrievals if retrieval.status == RetrievalStatus.AVAILABLE]
    decided = sum(
        1 for retrieval in available if valid_final_decision(db, retrieval.publication_id, ScreeningStage.FULL_TEXT) is not None
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
            f"{decided} of {len(available)} screened",
        ),
    ]


def _extraction_items(db: Session, project: Project) -> list[dict]:
    extraction_total = db.scalar(
        select(func.count()).select_from(ExtractionWorkItem).where(ExtractionWorkItem.project_id == project.id)
    ) or 0
    extraction_done = db.scalar(
        select(func.count())
        .select_from(ExtractionWorkItem)
        .where(ExtractionWorkItem.project_id == project.id, ExtractionWorkItem.status == ExtractionStatus.COMPLETED)
    ) or 0
    items = [
        _item(
            "extraction",
            "Complete data extraction for every included publication",
            extraction_done == extraction_total,
            f"{extraction_done} of {extraction_total} extracted",
        ),
    ]
    config = db.scalar(select(QualityConfig).where(QualityConfig.project_id == project.id))
    if config is not None and config.enabled:
        quality_total = db.scalar(
            select(func.count()).select_from(QualityWorkItem).where(QualityWorkItem.project_id == project.id)
        ) or 0
        quality_done = db.scalar(
            select(func.count())
            .select_from(QualityWorkItem)
            .where(QualityWorkItem.project_id == project.id, QualityWorkItem.status == QualityStatus.COMPLETED)
        ) or 0
        items.append(
            _item(
                "quality",
                "Complete quality assessment for every included publication",
                quality_done == quality_total,
                f"{quality_done} of {quality_total} assessed",
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


def project_checklist(db: Session, project: Project) -> dict:
    current_index = STAGE_ORDER.index(project.stage)
    stages = []
    for index, stage in enumerate(STAGE_ORDER):
        builder = STAGE_BUILDERS.get(stage)
        items = builder(db, project) if builder else []
        is_complete = index < current_index or (stage == ProjectStage.COMPLETED and project.stage == ProjectStage.COMPLETED)
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
