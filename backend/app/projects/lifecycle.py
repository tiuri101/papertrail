from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import delete, select, update
from sqlalchemy.orm import Session

from app.audit.models import AuditEvent
from app.audit.service import record_audit
from app.conflicts.models import FinalDecision
from app.deduplication.models import DuplicateCandidate, PublicationMerge
from app.extraction.models import (
    ExtractionResponse,
    ExtractionStatus,
    ExtractionWorkItem,
    FinalExtraction,
)
from app.forms.models import FormField, FormVersion, ReviewForm
from app.fulltext.models import FullTextRetrieval
from app.fulltext.service import initialize_full_text_stage
from app.imports.models import ImportBatch, ImportedRecord, SearchSource
from app.jobs.models import BackgroundJob
from app.jobs.service import enqueue_job
from app.llm.models import ExtractionSuggestionReview
from app.projects.models import Project, ProjectStage, ScreeningStage
from app.publications.models import MetadataConflict, Publication, PublicationSource
from app.quality.models import (
    QualityConfig,
    QualityResponse,
    QualityStatus,
    QualityWorkItem,
)
from app.reporting.models import ExportArtifact
from app.screening.models import ScreeningDecision, ScreeningOutcome, ScreeningWorkItem


def utcnow() -> datetime:
    return datetime.now(UTC)


def included_publication_ids(db: Session, project_id: str) -> set[str]:
    return set(
        db.scalars(
            select(FinalDecision.publication_id).where(
                FinalDecision.project_id == project_id,
                FinalDecision.stage == ScreeningStage.FULL_TEXT,
                FinalDecision.outcome == ScreeningOutcome.INCLUDE,
                FinalDecision.is_valid.is_(True),
            )
        )
    )


def evaluate_project_completion(db: Session, project: Project) -> bool:
    if project.stage != ProjectStage.EXTRACTION:
        return project.stage == ProjectStage.COMPLETED

    # An earlier decision can be revised without moving the project back.  Do
    # not mark extraction complete while that revision has introduced pending
    # full-text retrieval or screening work.
    from app.fulltext.service import full_text_work_completed

    if not full_text_work_completed(db, project):
        return False

    included_ids = included_publication_ids(db, project.id)
    extraction_items = list(
        db.scalars(
            select(ExtractionWorkItem).where(
                ExtractionWorkItem.project_id == project.id
            )
        )
    )
    extraction_publications = {item.publication_id for item in extraction_items}
    if extraction_publications != included_ids:
        return False
    if any(item.status != ExtractionStatus.COMPLETED for item in extraction_items):
        return False

    # Every required extraction slot being COMPLETED is necessary but not
    # sufficient in dual-extraction mode: a publication whose two slots
    # disagree stays in the reconciliation queue with no authoritative
    # result until an adjudicator resolves it. Completion requires an
    # authoritative FinalExtraction for every included publication too.
    from app.extraction.final import get_current_final_extractions

    finals = get_current_final_extractions(db, list(included_ids))
    if set(finals) != included_ids:
        return False

    from app.llm.schema_service import project_settings

    llm_settings = project_settings(db, project.id)
    if llm_settings and llm_settings.extraction_validation_enabled:
        from app.llm.task_service import project_validation_progress

        if not project_validation_progress(db, project.id).settled:
            return False

    quality_config = db.scalar(
        select(QualityConfig).where(QualityConfig.project_id == project.id)
    )
    if quality_config and quality_config.enabled:
        quality_items = list(
            db.scalars(
                select(QualityWorkItem).where(QualityWorkItem.project_id == project.id)
            )
        )
        quality_by_publication = {item.publication_id: item for item in quality_items}
        if set(quality_by_publication) != included_ids:
            return False
        if any(
            item.status != QualityStatus.COMPLETED
            for item in quality_by_publication.values()
        ):
            return False

    project.stage = ProjectStage.COMPLETED
    project.completed_at = utcnow()
    record_audit(
        db,
        action="project.completed",
        entity_type="project",
        entity_id=project.id,
        project_id=project.id,
        summary="Project completed automatically",
    )
    from app.notifications.service import queue_project_completed_emails

    queue_project_completed_emails(db, project, project.completed_at)
    enqueue_job(
        db,
        "generate_stage_analysis",
        {"stage": "extraction_quality"},
        project_id=project.id,
        created_by_id=None,
        priority=5,
    )
    db.flush()
    return True


def reopen_project(
    db: Session,
    project: Project,
    target_stage: ProjectStage,
    actor_id: str,
) -> Project:
    if project.stage != ProjectStage.COMPLETED:
        raise ValueError("Only completed projects can be reopened")
    if target_stage == ProjectStage.COMPLETED:
        raise ValueError("Reopen target must be an active workflow stage")

    previous_stage = project.stage
    project.stage = target_stage
    project.completed_at = None
    project.reopened_at = utcnow()

    if target_stage == ProjectStage.FULL_TEXT:
        initialize_full_text_stage(db, project)
    elif target_stage == ProjectStage.EXTRACTION:
        from app.extraction.service import initialize_extraction
        from app.quality.service import initialize_quality

        initialize_extraction(db, project)
        initialize_quality(db, project)

    record_audit(
        db,
        action="project.reopened",
        entity_type="project",
        entity_id=project.id,
        project_id=project.id,
        actor_id=actor_id,
        summary=f"Reopened project at {target_stage.value}",
        metadata={
            "previousStage": previous_stage.value,
            "targetStage": target_stage.value,
        },
    )
    db.flush()
    return project


STAGE_ORDER = [
    ProjectStage.DRAFT,
    ProjectStage.DUPLICATE_REVIEW,
    ProjectStage.TITLE_ABSTRACT,
    ProjectStage.FULL_TEXT,
    ProjectStage.EXTRACTION,
    ProjectStage.COMPLETED,
]


def _reverse_duplicate_review(db: Session, project: Project, actor_id: str) -> None:
    from app.deduplication.service import reverse_merge

    merges = list(
        db.scalars(
            select(PublicationMerge).where(
                PublicationMerge.project_id == project.id,
                PublicationMerge.reversed_at.is_(None),
            )
        )
    )
    for merge in merges:
        reverse_merge(db, merge, actor_id)
    db.execute(
        delete(PublicationMerge).where(PublicationMerge.project_id == project.id)
    )
    db.execute(
        delete(DuplicateCandidate).where(DuplicateCandidate.project_id == project.id)
    )
    db.execute(
        delete(MetadataConflict).where(
            MetadataConflict.publication_id.in_(
                select(Publication.id).where(Publication.project_id == project.id)
            ),
            MetadataConflict.source_name == "merge",
        )
    )


def _wipe_screening_stage(db: Session, project_id: str, stage: ScreeningStage) -> None:
    work_item_ids = select(ScreeningWorkItem.id).where(
        ScreeningWorkItem.project_id == project_id, ScreeningWorkItem.stage == stage
    )
    db.execute(
        delete(ScreeningDecision).where(
            ScreeningDecision.work_item_id.in_(work_item_ids)
        )
    )
    db.execute(
        delete(ScreeningWorkItem).where(
            ScreeningWorkItem.project_id == project_id, ScreeningWorkItem.stage == stage
        )
    )
    db.execute(
        delete(FinalDecision).where(
            FinalDecision.project_id == project_id, FinalDecision.stage == stage
        )
    )


def _wipe_full_text_stage(db: Session, project_id: str) -> None:
    _wipe_screening_stage(db, project_id, ScreeningStage.FULL_TEXT)
    db.execute(
        delete(FullTextRetrieval).where(FullTextRetrieval.project_id == project_id)
    )


def _wipe_extraction_and_quality(db: Session, project_id: str) -> None:
    extraction_item_ids = select(ExtractionWorkItem.id).where(
        ExtractionWorkItem.project_id == project_id
    )
    quality_item_ids = select(QualityWorkItem.id).where(
        QualityWorkItem.project_id == project_id
    )
    response_ids = select(ExtractionResponse.id).where(
        ExtractionResponse.work_item_id.in_(extraction_item_ids)
    )
    db.execute(
        update(ExtractionSuggestionReview)
        .where(ExtractionSuggestionReview.extraction_response_id.in_(response_ids))
        .values(extraction_response_id=None)
    )
    db.execute(
        delete(ExtractionResponse).where(
            ExtractionResponse.work_item_id.in_(extraction_item_ids)
        )
    )
    db.execute(
        delete(QualityResponse).where(
            QualityResponse.work_item_id.in_(quality_item_ids)
        )
    )
    db.execute(
        delete(FinalExtraction).where(FinalExtraction.project_id == project_id)
    )
    db.execute(
        delete(ExtractionWorkItem).where(ExtractionWorkItem.project_id == project_id)
    )
    db.execute(delete(QualityWorkItem).where(QualityWorkItem.project_id == project_id))


def move_project_back(
    db: Session,
    project: Project,
    target_stage: ProjectStage,
    actor_id: str,
) -> Project:
    """Move an active project to an earlier stage, resetting workflow data.

    Unlike ``reopen_project`` (which only applies to completed projects),
    this is the "move backward" path for a project that's still in progress.
    All work produced in stages after ``target_stage`` is deleted, and
    ``target_stage`` itself is reset to a freshly-entered state — its own
    decisions/candidates/retrievals are cleared and its work items
    regenerated — so the project can be worked back through from that point.
    Configuration (research questions, criteria, forms, members) and data
    from stages before ``target_stage`` are left untouched.
    """
    if project.stage in (ProjectStage.DRAFT, ProjectStage.COMPLETED):
        raise ValueError(
            "Only an active, in-progress project can be moved back a stage"
        )
    current_index = STAGE_ORDER.index(project.stage)
    target_index = STAGE_ORDER.index(target_stage)
    if target_index >= current_index:
        raise ValueError("Target stage must be earlier than the current stage")

    previous_stage = project.stage

    if target_stage == ProjectStage.DRAFT:
        wipe_workflow_data(db, project.id)
    else:
        stage_wipers = {
            ProjectStage.DUPLICATE_REVIEW: lambda: _reverse_duplicate_review(
                db, project, actor_id
            ),
            ProjectStage.TITLE_ABSTRACT: lambda: _wipe_screening_stage(
                db, project.id, ScreeningStage.TITLE_ABSTRACT
            ),
            ProjectStage.FULL_TEXT: lambda: _wipe_full_text_stage(db, project.id),
            ProjectStage.EXTRACTION: lambda: _wipe_extraction_and_quality(
                db, project.id
            ),
        }
        for stage in STAGE_ORDER:
            if STAGE_ORDER.index(stage) >= target_index and stage in stage_wipers:
                stage_wipers[stage]()

        if target_stage == ProjectStage.DUPLICATE_REVIEW:
            from app.deduplication.service import detect_duplicates

            detect_duplicates(db, project.id)
        elif target_stage == ProjectStage.TITLE_ABSTRACT:
            from app.screening.service import create_screening_work_items

            create_screening_work_items(db, project, ScreeningStage.TITLE_ABSTRACT)
        elif target_stage == ProjectStage.FULL_TEXT:
            initialize_full_text_stage(db, project)

    project.stage = target_stage
    record_audit(
        db,
        action="project.moved_back",
        entity_type="project",
        entity_id=project.id,
        project_id=project.id,
        actor_id=actor_id,
        summary=f"Moved project back to {target_stage.value}",
        metadata={
            "previousStage": previous_stage.value,
            "targetStage": target_stage.value,
        },
    )
    db.flush()
    return project


def project_integrity_issues(db: Session, project: Project) -> list[dict[str, str]]:
    issues: list[dict[str, str]] = []
    included_ids = included_publication_ids(db, project.id)

    extraction_ids = set(
        db.scalars(
            select(ExtractionWorkItem.publication_id).where(
                ExtractionWorkItem.project_id == project.id
            )
        )
    )
    for publication_id in sorted(included_ids - extraction_ids):
        issues.append(
            {
                "code": "missing_extraction_item",
                "entityId": publication_id,
                "message": "Included publication has no extraction work item.",
            }
        )

    quality_config = db.scalar(
        select(QualityConfig).where(QualityConfig.project_id == project.id)
    )
    if quality_config and quality_config.enabled:
        quality_ids = set(
            db.scalars(
                select(QualityWorkItem.publication_id).where(
                    QualityWorkItem.project_id == project.id
                )
            )
        )
        for publication_id in sorted(included_ids - quality_ids):
            issues.append(
                {
                    "code": "missing_quality_item",
                    "entityId": publication_id,
                    "message": "Included publication has no quality-assessment work item.",
                }
            )

    duplicate_slots = db.execute(
        select(
            ScreeningWorkItem.publication_id,
            ScreeningWorkItem.stage,
            ScreeningWorkItem.slot_number,
        ).where(ScreeningWorkItem.project_id == project.id)
    ).all()
    seen_slots: set[tuple[str, object, int]] = set()
    for publication_id, stage, slot_number in duplicate_slots:
        key = (publication_id, stage, slot_number)
        if key in seen_slots:
            issues.append(
                {
                    "code": "duplicate_screening_slot",
                    "entityId": publication_id,
                    "message": f"Duplicate reviewer slot {slot_number} exists for {stage.value}.",
                }
            )
        seen_slots.add(key)

    active_forms = list(
        db.scalars(
            select(ReviewForm).where(
                ReviewForm.project_id == project.id,
                ReviewForm.active_version_id.is_not(None),
            )
        )
    )
    for form in active_forms:
        field_count = len(
            list(
                db.scalars(
                    select(FormField.id).where(
                        FormField.form_version_id == form.active_version_id,
                        FormField.is_archived.is_(False),
                    )
                )
            )
        )
        if field_count == 0:
            issues.append(
                {
                    "code": "empty_active_form",
                    "entityId": form.id,
                    "message": f"Active form {form.name} has no active fields.",
                }
            )

    return issues


def wipe_workflow_data(db: Session, project_id: str) -> None:
    """Delete every publication, import, and workflow-progress record for a project.

    Leaves the project's configuration (research questions, criteria, screening
    configs, forms, members) untouched so callers can decide separately whether
    to keep it (reset) or remove it too (delete).
    """
    extraction_item_ids = select(ExtractionWorkItem.id).where(
        ExtractionWorkItem.project_id == project_id
    )
    quality_item_ids = select(QualityWorkItem.id).where(
        QualityWorkItem.project_id == project_id
    )
    screening_item_ids = select(ScreeningWorkItem.id).where(
        ScreeningWorkItem.project_id == project_id
    )
    publication_ids = select(Publication.id).where(Publication.project_id == project_id)
    import_batch_ids = select(ImportBatch.id).where(
        ImportBatch.project_id == project_id
    )

    response_ids = select(ExtractionResponse.id).where(
        ExtractionResponse.work_item_id.in_(extraction_item_ids)
    )
    db.execute(
        update(ExtractionSuggestionReview)
        .where(ExtractionSuggestionReview.extraction_response_id.in_(response_ids))
        .values(extraction_response_id=None)
    )

    db.execute(
        delete(ExtractionResponse).where(
            ExtractionResponse.work_item_id.in_(extraction_item_ids)
        )
    )
    db.execute(
        delete(QualityResponse).where(
            QualityResponse.work_item_id.in_(quality_item_ids)
        )
    )
    db.execute(
        delete(ScreeningDecision).where(
            ScreeningDecision.work_item_id.in_(screening_item_ids)
        )
    )
    db.execute(
        delete(FinalExtraction).where(FinalExtraction.project_id == project_id)
    )
    db.execute(
        delete(ExtractionWorkItem).where(ExtractionWorkItem.project_id == project_id)
    )
    db.execute(delete(QualityWorkItem).where(QualityWorkItem.project_id == project_id))
    db.execute(
        delete(ScreeningWorkItem).where(ScreeningWorkItem.project_id == project_id)
    )
    db.execute(delete(FinalDecision).where(FinalDecision.project_id == project_id))
    db.execute(
        delete(FullTextRetrieval).where(FullTextRetrieval.project_id == project_id)
    )
    db.execute(
        delete(PublicationMerge).where(PublicationMerge.project_id == project_id)
    )
    db.execute(
        delete(DuplicateCandidate).where(DuplicateCandidate.project_id == project_id)
    )
    db.execute(
        delete(MetadataConflict).where(
            MetadataConflict.publication_id.in_(publication_ids)
        )
    )
    db.execute(
        delete(PublicationSource).where(
            PublicationSource.publication_id.in_(publication_ids)
        )
    )
    db.execute(delete(Publication).where(Publication.project_id == project_id))
    db.execute(
        delete(ImportedRecord).where(
            ImportedRecord.import_batch_id.in_(import_batch_ids)
        )
    )
    db.execute(delete(ImportBatch).where(ImportBatch.project_id == project_id))
    db.execute(delete(SearchSource).where(SearchSource.project_id == project_id))
    db.execute(delete(ExportArtifact).where(ExportArtifact.project_id == project_id))
    db.execute(delete(BackgroundJob).where(BackgroundJob.project_id == project_id))
    db.flush()


def reset_project(db: Session, project: Project, actor_id: str) -> Project:
    """Wipe all publications and workflow progress, returning the project to draft.

    Research questions, criteria, screening configuration, forms, and project
    membership are preserved.
    """
    previous_stage = project.stage
    wipe_workflow_data(db, project.id)
    project.stage = ProjectStage.DRAFT
    project.completed_at = None
    project.reopened_at = None
    record_audit(
        db,
        action="project.reset",
        entity_type="project",
        entity_id=project.id,
        project_id=project.id,
        actor_id=actor_id,
        summary=f"Reset project {project.name} to draft",
        metadata={"previousStage": previous_stage.value},
    )
    db.flush()
    return project


def delete_project(db: Session, project: Project) -> None:
    """Permanently delete a project and all of its data, including configuration."""
    wipe_workflow_data(db, project.id)

    form_ids = select(ReviewForm.id).where(ReviewForm.project_id == project.id)
    version_ids = select(FormVersion.id).where(FormVersion.form_id.in_(form_ids))
    db.execute(delete(FormField).where(FormField.form_version_id.in_(version_ids)))
    db.execute(delete(FormVersion).where(FormVersion.form_id.in_(form_ids)))
    db.execute(delete(ReviewForm).where(ReviewForm.project_id == project.id))
    db.execute(delete(QualityConfig).where(QualityConfig.project_id == project.id))
    db.execute(delete(AuditEvent).where(AuditEvent.project_id == project.id))

    db.delete(project)
    db.flush()
