from __future__ import annotations

from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.conflicts.models import FinalDecision
from app.conflicts.service import count_unfinalized_publications
from app.deduplication.models import DuplicateCandidate
from app.extraction.models import ExtractionStatus, ExtractionWorkItem
from app.fulltext.models import FullTextRetrieval, RetrievalStatus
from app.jobs.models import BackgroundJob, JobStatus
from app.llm.models import ProjectLlmSettings
from app.projects.models import (
    STAGE_ORDER,
    AllocationMode,
    CriterionKind,
    Project,
    ProjectMembership,
    ProjectStage,
    ScreeningStage,
    TaskAllocationMode,
)
from app.publications.models import Publication
from app.quality.models import QualityConfig, QualityStatus, QualityWorkItem
from app.screening.models import ScreeningWorkItem, WorkItemStatus

#: Checklist section headings -- distinct from the generic stage order/labels
#: in app.projects.lifecycle, which other consumers use for a plain "what
#: stage is this" display rather than this page's task-oriented wording.
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


def _claim_pool_detail(remaining: int, open_total: int, verb: str) -> str:
    """Queue detail line for a claim-mode stage.

    In claim mode work items sit unassigned until a reviewer claims one, so a
    per-reviewer "awaiting your decision" count is ~always zero however much
    work is left in the stage -- "0 awaiting your decision" then reads as
    "nothing for you to do" when the shared pool is in fact full. Report the
    pool the reviewer draws from instead.
    """
    if remaining == 0:
        return f"Nothing for you to claim right now ({open_total} open in total)"
    return f"{remaining} available for you to {verb} ({open_total} open in total)"


def _screening_decision_detail(
    db: Session,
    project: Project,
    user_id: str | None,
    stage: ScreeningStage,
    open_total: int,
) -> str:
    """The screening "… awaiting your decision" line, phrased for the stage's
    allocation mode: a personal assignment count under independent/divided
    allocation, the claimable shared pool under claim allocation."""
    from app.screening.service import (
        get_screening_config,
        remaining_claimable_publications,
    )

    config = get_screening_config(db, project.id, stage)
    if (
        user_id
        and config is not None
        and config.allocation_mode == AllocationMode.CLAIM
    ):
        remaining = remaining_claimable_publications(
            db, project.id, stage, user_id
        )
        return _claim_pool_detail(remaining, open_total, "screen")
    my_open = _my_open_work_item_count(
        db,
        ScreeningWorkItem,
        project.id,
        user_id,
        extra_clauses=(ScreeningWorkItem.stage == stage,),
    )
    return f"{my_open} awaiting your decision ({open_total} open in total)"


def _title_abstract_items(
    db: Session, project: Project, user_id: str | None
) -> list[dict[str, Any]]:
    unresolved = count_unfinalized_publications(
        db, project.id, ScreeningStage.TITLE_ABSTRACT
    )
    return [
        _item(
            "title_abstract_decisions",
            "Reach a final include/exclude decision for every publication",
            unresolved == 0,
            _screening_decision_detail(
                db, project, user_id, ScreeningStage.TITLE_ABSTRACT, unresolved
            ),
        ),
    ]


def _full_text_items(
    db: Session, project: Project, user_id: str | None
) -> list[dict[str, Any]]:
    from app.extraction.service import project_form

    # Grouped counts rather than loading every retrieval row into Python --
    # the old version materialized the whole project's FullTextRetrieval
    # table on every checklist poll.
    total = (
        db.scalar(
            select(func.count())
            .select_from(FullTextRetrieval)
            .where(FullTextRetrieval.project_id == project.id)
        )
        or 0
    )
    retrieved = (
        db.scalar(
            select(func.count())
            .select_from(FullTextRetrieval)
            .where(
                FullTextRetrieval.project_id == project.id,
                FullTextRetrieval.status.notin_(
                    {RetrievalStatus.NOT_YET_SOUGHT, RetrievalStatus.REQUESTED}
                ),
            )
        )
        or 0
    )
    available_total = (
        db.scalar(
            select(func.count())
            .select_from(FullTextRetrieval)
            .where(
                FullTextRetrieval.project_id == project.id,
                FullTextRetrieval.status == RetrievalStatus.AVAILABLE,
            )
        )
        or 0
    )
    available_publication_ids = select(FullTextRetrieval.publication_id).where(
        FullTextRetrieval.project_id == project.id,
        FullTextRetrieval.status == RetrievalStatus.AVAILABLE,
    )
    decided = (
        db.scalar(
            select(func.count(func.distinct(FinalDecision.publication_id))).where(
                FinalDecision.publication_id.in_(available_publication_ids),
                FinalDecision.stage == ScreeningStage.FULL_TEXT,
                FinalDecision.is_valid.is_(True),
            )
        )
        or 0
    )
    has_extraction_form = project_form(db, project.id) is not None
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
            decided == available_total,
            _screening_decision_detail(
                db,
                project,
                user_id,
                ScreeningStage.FULL_TEXT,
                available_total - decided,
            ),
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
    from app.extraction.final import get_current_final_extractions
    from app.extraction.service import (
        extraction_allocation_mode,
        included_publication_ids,
        remaining_claimable_extractions,
    )

    publication_ids = included_publication_ids(db, project.id)
    extraction_total = len(publication_ids)
    # "Complete" means every included publication has an authoritative final
    # extraction, not merely that every individual reviewer slot is
    # COMPLETED -- in dual-extraction mode a publication whose two slots
    # disagree stays open (in reconciliation) even though both slots are
    # individually done.
    extraction_done = len(get_current_final_extractions(db, publication_ids))
    extraction_open = extraction_total - extraction_done
    if (
        user_id
        and extraction_allocation_mode(db, project.id) == TaskAllocationMode.CLAIM
    ):
        extraction_detail = _claim_pool_detail(
            remaining_claimable_extractions(db, project.id, user_id),
            extraction_open,
            "extract",
        )
    else:
        my_open = _my_open_work_item_count(
            db, ExtractionWorkItem, project.id, user_id
        )
        extraction_detail = (
            f"{my_open} awaiting your extraction "
            f"({extraction_open} open in total)"
        )
    items = [
        _item(
            "extraction",
            "Complete data extraction for every included publication",
            extraction_done == extraction_total,
            extraction_detail,
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
        quality_open = quality_total - quality_done
        if user_id and config.allocation_mode == TaskAllocationMode.CLAIM:
            from app.quality.service import remaining_claimable_assessments

            quality_detail = _claim_pool_detail(
                remaining_claimable_assessments(db, project.id, user_id),
                quality_open,
                "assess",
            )
        else:
            my_open_quality = _my_open_work_item_count(
                db, QualityWorkItem, project.id, user_id
            )
            quality_detail = (
                f"{my_open_quality} awaiting your assessment "
                f"({quality_open} open in total)"
            )
        items.append(
            _item(
                "quality",
                "Complete quality assessment for every included publication",
                quality_done == quality_total,
                quality_detail,
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
        # Only the current stage's item list is ever rendered (the panel
        # keys off is_current); some builders are O(publications) with
        # per-publication queries, so building the other four just to
        # discard them made this endpoint scale badly on large projects.
        # Past/future stages still report is_complete from stage order.
        items = builder(db, project, user_id) if builder and stage == project.stage else []
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
