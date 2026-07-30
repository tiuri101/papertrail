from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.audit.service import record_audit
from app.conflicts.models import FinalDecision
from app.extraction.models import ExtractionStatus, ExtractionWorkItem
from app.forms.models import FormField, ReviewForm
from app.fulltext.service import initialize_full_text_stage
from app.projects.models import Project, ProjectStage, ScreeningStage
from app.quality.models import QualityConfig, QualityStatus, QualityWorkItem
from app.screening.models import ScreeningOutcome, ScreeningWorkItem


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


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

    included_ids = included_publication_ids(db, project.id)
    extraction_items = list(
        db.scalars(
            select(ExtractionWorkItem).where(ExtractionWorkItem.project_id == project.id)
        )
    )
    extraction_by_publication = {item.publication_id: item for item in extraction_items}
    if set(extraction_by_publication) != included_ids:
        return False
    if any(
        item.status != ExtractionStatus.COMPLETED
        for item in extraction_by_publication.values()
    ):
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
        metadata={"previousStage": previous_stage.value, "targetStage": target_stage.value},
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
        )
        .where(ScreeningWorkItem.project_id == project.id)
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
