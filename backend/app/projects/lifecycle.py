from __future__ import annotations

from sqlalchemy import delete, func, select, update
from sqlalchemy.orm import Session

from app.api.errors import ConflictError
from app.audit.models import AuditEvent
from app.audit.service import record_audit
from app.conflicts.models import FinalDecision
from app.core.time import utcnow
from app.deduplication.models import DuplicateCandidate, PublicationMerge
from app.extraction.models import (
    ExtractionConfig,
    ExtractionResponse,
    ExtractionStatus,
    ExtractionWorkItem,
    FinalExtraction,
)
from app.forms.models import FormField, FormVersion, ReviewForm
from app.fulltext.models import FullTextRetrieval
from app.fulltext.service import initialize_full_text_stage
from app.imports.models import ImportBatch, ImportedRecord, ImportStatus, SearchSource
from app.jobs.models import BackgroundJob, JobStatus
from app.jobs.service import enqueue_job
from app.llm.models import ExtractionSuggestionReview
from app.projects.job_safety import LifecycleOperation, guard_lifecycle_jobs
from app.projects.models import (
    STAGE_ORDER,
    AllocationMode,
    Project,
    ProjectMembership,
    ProjectStage,
    ResearchQuestion,
    ScreeningConfig,
    ScreeningStage,
    TaskAllocationMode,
)
from app.publications.models import MetadataConflict, Publication, PublicationSource
from app.quality.models import (
    QualityConfig,
    QualityResponse,
    QualityStatus,
    QualityWorkItem,
)
from app.reporting.models import ExportArtifact
from app.screening.cohorts import full_text_included_ids
from app.screening.models import ScreeningDecision, ScreeningWorkItem


def set_project_stage(
    project: Project,
    target_stage: ProjectStage,
    *,
    reason: str,
) -> None:
    """The only place in the codebase that assigns ``Project.stage``.

    ``reason`` documents at the call site *why* this particular transition is
    happening (it is not persisted -- most callers already write their own,
    more specific audit event alongside this call; this parameter exists so a
    reader of the call site doesn't have to go find that event to know why).
    Routing every stage write through one function -- rather than a domain
    module reaching into ``project.stage = ...`` directly -- means the set of
    places that can change a project's stage is exactly the set of places
    this module (or a caller that imports this function) chooses to call it,
    which is what makes ``project.stage`` an invariant other code can trust
    rather than a field anyone can reassign.
    """
    del reason  # documentation only, see docstring
    project.stage = target_stage


def evaluate_project_completion(db: Session, project: Project) -> bool:
    if project.stage != ProjectStage.EXTRACTION:
        return project.stage == ProjectStage.COMPLETED

    # An earlier decision can be revised without moving the project back.  Do
    # not mark extraction complete while that revision has introduced pending
    # full-text retrieval or screening work.
    from app.fulltext.service import full_text_work_completed

    if not full_text_work_completed(db, project):
        return False

    included_ids = set(full_text_included_ids(db, project.id))
    # Scoped to the *currently* included cohort in both directions: every
    # included publication must have its extraction slots, and those slots
    # must be complete. A work item left behind for a publication that has
    # since left the cohort -- excluded on a revised decision, or removed
    # from the review entirely -- is no longer relevant and must not block
    # completion forever, the same way full_text_work_completed ignores a
    # stray FullTextRetrieval.
    extraction_items = list(
        db.scalars(
            select(ExtractionWorkItem).where(
                ExtractionWorkItem.project_id == project.id,
                ExtractionWorkItem.publication_id.in_(included_ids),
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
                select(QualityWorkItem).where(
                    QualityWorkItem.project_id == project.id,
                    QualityWorkItem.publication_id.in_(included_ids),
                )
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

    set_project_stage(project, ProjectStage.COMPLETED, reason="all workflow stages finished")
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

    from app.llm.installation_settings import effective_llm_settings

    narrative_enabled = (
        llm_settings.analysis_narrative_enabled if llm_settings else True
    )
    config = effective_llm_settings(db)
    if config.llm_enabled and config.ollama_model and narrative_enabled:
        from app.analysis.rq_jobs import queue_rq_synthesis

        research_questions = db.scalars(
            select(ResearchQuestion).where(ResearchQuestion.project_id == project.id)
        )
        for research_question in research_questions:
            queue_rq_synthesis(
                db, project.id, research_question, created_by_id=None, priority=5
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
    set_project_stage(project, target_stage, reason="manager reopened a completed project")
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


class MergeReversalStageError(ConflictError):
    """Undo Merge was attempted after the project left duplicate review.

    409 rather than 400: the request was valid earlier and conflicts only
    with the stage the project has since reached.  The distinct code lets a
    client point the user at Move Back instead of showing a generic error.
    """

    code = "merge_reversal_stage_locked"

    def __init__(self, project_stage: ProjectStage) -> None:
        super().__init__(
            "This merge can only be undone in duplicate review. Move the "
            "project back to duplicate review to revisit its merges.",
            details={
                "projectStage": project_stage.value,
                "requiredStage": ProjectStage.DUPLICATE_REVIEW.value,
            },
        )


def require_merge_reversal_allowed(
    db: Session, project: Project, merge: PublicationMerge | None = None
) -> None:
    """Gate a standalone Undo Merge on the project still being reversible.

    Reversing a merge re-activates the merged-away publication and hands its
    sources and documents back.  Downstream stages are built from the *post*
    -merge cohort: the canonical publication carries screening work items,
    decisions, retrievals and possibly extraction results that were produced
    on the merged record, and the restored duplicate has none of them.  There
    is no consistent state to land in once that work exists -- which is why
    the old behavior of silently assigning ``project.stage =
    DUPLICATE_REVIEW`` from the deduplication routes was wrong: it rewound
    the stage label while leaving every downstream row exactly where it was.

    So a standalone reversal is confined to the stage that owns merges.  A
    project that has moved on goes back through ``move_project_back``, which
    reverses *all* merges, clears the downstream work, and re-runs detection
    as one coherent lifecycle operation.  Job safety is shared with the other
    destructive operations: a running duplicate-detection or LLM job must not
    be racing the reversal.

    The one exception is a merge made during screening (records imported
    after duplicate review), while the project is still in the stage it was
    made in and the merged-away record carries no screening work of its own:
    nothing downstream was built on it, so restoring it is coherent. With no
    ``merge`` (revising a "not duplicate" into a merge), any stage that still
    takes duplicate decisions is fine.
    """
    from app.deduplication.service import DEDUP_DURING_REVIEW_STAGES
    from app.screening.service import screened_publication_ids

    if project.stage != ProjectStage.DUPLICATE_REVIEW:
        allowed = project.stage in DEDUP_DURING_REVIEW_STAGES and (
            merge is None
            or (
                merge.stage_at_merge == project.stage.value
                and not screened_publication_ids(db, [merge.merged_publication_id])
            )
        )
        if not allowed:
            raise MergeReversalStageError(project.stage)
    guard_lifecycle_jobs(db, project.id, operation=LifecycleOperation.UNDO_MERGE)


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
    db.execute(delete(FinalExtraction).where(FinalExtraction.project_id == project_id))
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

    cancelled_jobs = guard_lifecycle_jobs(
        db, project.id, operation=LifecycleOperation.MOVE_BACK
    )
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

    set_project_stage(project, target_stage, reason="manager moved the project back")
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
            "cancelledQueuedJobs": cancelled_jobs,
        },
    )
    db.flush()
    return project


#: How a detected issue should be presented/acted on.
#:   repairable   -- reconcile_workflow_integrity() has a deterministic,
#:                   non-destructive fix for it.
#:   manual       -- a person has to decide (a scientific/reviewer judgment,
#:                   or a fix that could destroy in-progress work), never
#:                   auto-repaired.
#:   informational -- not wrong by itself, surfaced for awareness only.
IntegritySeverity = str  # "repairable" | "manual" | "informational"


def _issue(
    code: str, entity_id: str, message: str, *, severity: IntegritySeverity
) -> dict[str, str]:
    return {
        "code": code,
        "entityId": entity_id,
        "message": message,
        "severity": severity,
    }


def project_integrity_issues(db: Session, project: Project) -> list[dict[str, str]]:
    issues: list[dict[str, str]] = []

    owners = list(
        db.scalars(
            select(ProjectMembership.id).where(
                ProjectMembership.project_id == project.id,
                ProjectMembership.is_owner.is_(True),
            )
        )
    )
    if len(owners) == 0:
        issues.append(
            _issue(
                "no_project_owner",
                project.id,
                "Project has no owner. Use Transfer Ownership to assign one.",
                severity="manual",
            )
        )
    elif len(owners) > 1:
        issues.append(
            _issue(
                "multiple_project_owners",
                project.id,
                f"Project has {len(owners)} owners; exactly one is expected.",
                severity="repairable",
            )
        )

    # Extraction and quality items are initialized as one batch only after all
    # relevant full-text retrievals and screening decisions have settled. A
    # full-text INCLUDE before that transition is therefore normal, not
    # workflow drift. Only validate downstream coverage once the project has
    # actually reached a stage where those items must exist.
    if project.stage in {ProjectStage.EXTRACTION, ProjectStage.COMPLETED}:
        included_ids = set(full_text_included_ids(db, project.id))
        extraction_items = list(
            db.scalars(
                select(ExtractionWorkItem).where(
                    ExtractionWorkItem.project_id == project.id
                )
            )
        )
        extraction_ids = {item.publication_id for item in extraction_items}
        for publication_id in sorted(included_ids - extraction_ids):
            issues.append(
                _issue(
                    "missing_extraction_item",
                    publication_id,
                    "Included publication has no extraction work item.",
                    severity="repairable",
                )
            )

        # All required slots complete but no authoritative FinalExtraction:
        # exactly the lost-finalization state concurrent slot completion used
        # to be able to produce. attempt_auto_finalize() re-derives the
        # outcome from the current slot responses -- agreement produces the
        # missing FinalExtraction, disagreement produces the reconciliation
        # state -- so it is safe to simply re-run.
        extraction_config = db.scalar(
            select(ExtractionConfig).where(ExtractionConfig.project_id == project.id)
        )
        required_slots = extraction_config.required_reviewers if extraction_config else 1
        slots_by_publication: dict[str, list[ExtractionWorkItem]] = {}
        for item in extraction_items:
            slots_by_publication.setdefault(item.publication_id, []).append(item)
        finalized_ids = set(
            db.scalars(
                select(FinalExtraction.publication_id).where(
                    FinalExtraction.publication_id.in_(included_ids),
                    FinalExtraction.is_valid.is_(True),
                )
            )
        )
        for publication_id in sorted(included_ids - finalized_ids):
            slots = slots_by_publication.get(publication_id, [])
            if len(slots) >= required_slots and all(
                slot.status == ExtractionStatus.COMPLETED for slot in slots
            ):
                issues.append(
                    _issue(
                        "extraction_complete_without_final",
                        publication_id,
                        "All extraction slots are complete but no current "
                        "FinalExtraction exists.",
                        severity="repairable",
                    )
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
                    _issue(
                        "missing_quality_item",
                        publication_id,
                        "Included publication has no quality-assessment work item.",
                        severity="repairable",
                    )
                )

    # A publication no longer active (deleted, or merged away) must not still
    # carry a valid, currently-counted screening decision -- that would make
    # it reappear in cohorts/queues/reporting despite being invisible in the
    # Publications list. remove_publications_from_review() already retracts
    # this for publications it removes; this is defense in depth for any
    # other path that deactivates a publication.
    stray_final_decisions = list(
        db.execute(
            select(FinalDecision.id, FinalDecision.publication_id)
            .join(Publication, Publication.id == FinalDecision.publication_id)
            .where(
                FinalDecision.project_id == project.id,
                FinalDecision.is_valid.is_(True),
                Publication.is_active.is_(False),
            )
        ).all()
    )
    for _decision_id, publication_id in stray_final_decisions:
        issues.append(
            _issue(
                "inactive_publication_in_cohort",
                publication_id,
                "An inactive publication still has a valid final screening "
                "decision counted toward the active review.",
                severity="repairable",
            )
        )

    # Screening slots are generated once, at the required-reviewer count in
    # force at that time, and Issue 4's freeze keeps that count from changing
    # afterward. A mismatch therefore reflects data written before the freeze
    # existed, not a live race -- flagged for a human because collapsing or
    # growing slots after reviewers may have already submitted into them
    # risks losing or duplicating a decision.
    screening_configs = {
        config.stage: config
        for config in db.scalars(
            select(ScreeningConfig).where(ScreeningConfig.project_id == project.id)
        )
    }
    slot_counts = db.execute(
        select(
            ScreeningWorkItem.publication_id,
            ScreeningWorkItem.stage,
            func.count(func.distinct(ScreeningWorkItem.slot_number)),
        )
        .where(ScreeningWorkItem.project_id == project.id)
        .group_by(ScreeningWorkItem.publication_id, ScreeningWorkItem.stage)
    ).all()
    for publication_id, stage, slot_count in slot_counts:
        config = screening_configs.get(stage)
        if config is not None and slot_count > config.required_reviewers:
            issues.append(
                _issue(
                    "screening_slot_count_mismatch",
                    publication_id,
                    f"{stage.value} has {slot_count} reviewer slots but the "
                    f"current configuration expects {config.required_reviewers}.",
                    severity="manual",
                )
            )

    # A pre-assigned work item with nobody assigned to it is invisible to
    # every reviewer and to the manager reassignment sweep alike -- it can
    # only have been produced by data predating Issue 4's freeze, since
    # initialize_*() always assigns a reviewer up front in this mode.
    # Screening has no literal "pre-assigned" mode value -- CLAIM leaves
    # assigned_reviewer_id unset until claimed, while both other modes
    # (INDEPENDENT, DIVIDED) assign a reviewer up front, so "not CLAIM" is
    # the actual pre-assignment condition here (see create_screening_work_items).
    preassigned_screening_stages = set(
        db.scalars(
            select(ScreeningConfig.stage).where(
                ScreeningConfig.project_id == project.id,
                ScreeningConfig.allocation_mode != AllocationMode.CLAIM,
            )
        )
    )
    if preassigned_screening_stages:
        unassigned = db.scalars(
            select(ScreeningWorkItem.publication_id).where(
                ScreeningWorkItem.project_id == project.id,
                ScreeningWorkItem.stage.in_(preassigned_screening_stages),
                ScreeningWorkItem.assigned_reviewer_id.is_(None),
            )
        )
        for publication_id in sorted(set(unassigned)):
            issues.append(
                _issue(
                    "preassigned_item_unassigned",
                    publication_id,
                    "A pre-assigned screening work item has no assigned reviewer.",
                    severity="manual",
                )
            )

    # Extraction and quality each have exactly one per-project config (no
    # per-stage split like screening), so these two are written out directly
    # rather than looped over two model classes with incompatible column
    # types.
    extraction_config = db.scalar(
        select(ExtractionConfig).where(ExtractionConfig.project_id == project.id)
    )
    if (
        extraction_config is not None
        and extraction_config.allocation_mode == TaskAllocationMode.PRE_ASSIGNED
    ):
        unassigned_extraction = db.scalars(
            select(ExtractionWorkItem.publication_id).where(
                ExtractionWorkItem.project_id == project.id,
                ExtractionWorkItem.assigned_reviewer_id.is_(None),
            )
        )
        for publication_id in sorted(set(unassigned_extraction)):
            issues.append(
                _issue(
                    "preassigned_item_unassigned",
                    publication_id,
                    "A pre-assigned extraction work item has no assigned reviewer.",
                    severity="manual",
                )
            )

    quality_alloc_config = db.scalar(
        select(QualityConfig).where(QualityConfig.project_id == project.id)
    )
    if (
        quality_alloc_config is not None
        and quality_alloc_config.allocation_mode == TaskAllocationMode.PRE_ASSIGNED
    ):
        unassigned_quality = db.scalars(
            select(QualityWorkItem.publication_id).where(
                QualityWorkItem.project_id == project.id,
                QualityWorkItem.assigned_reviewer_id.is_(None),
            )
        )
        for publication_id in sorted(set(unassigned_quality)):
            issues.append(
                _issue(
                    "preassigned_item_unassigned",
                    publication_id,
                    "A pre-assigned quality work item has no assigned reviewer.",
                    severity="manual",
                )
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
                _issue(
                    "duplicate_screening_slot",
                    publication_id,
                    f"Duplicate reviewer slot {slot_number} exists for {stage.value}.",
                    severity="manual",
                )
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
                _issue(
                    "empty_active_form",
                    form.id,
                    f"Active form {form.name} has no active fields.",
                    severity="manual",
                )
            )

    # A project marked COMPLETED whose completion criteria no longer hold
    # (e.g. a late decision reopened work but the stage wasn't rewound with
    # it) is workflow state inconsistent with the current stage. Reopening is
    # a visible, consequential action -- surfaced for a manager to act on via
    # Reopen Project, never done silently by a repair sweep.
    if project.stage == ProjectStage.COMPLETED and not evaluate_project_completion(
        db, project
    ):
        issues.append(
            _issue(
                "completed_project_incomplete",
                project.id,
                "Project is marked Completed but its completion criteria no "
                "longer hold. Consider Reopen Project.",
                severity="manual",
            )
        )

    # An import batch stuck reporting PROCESSING after its job has already
    # reached a terminal state is exactly the state Issue 1's permanent-
    # failure hook and reap_abandoned_jobs() exist to prevent going forward;
    # this catches drift from before that existed, or a hook that didn't run.
    processing_batches = list(
        db.scalars(
            select(ImportBatch).where(
                ImportBatch.project_id == project.id,
                ImportBatch.status == ImportStatus.PROCESSING,
            )
        )
    )
    if processing_batches:
        relevant_jobs = list(
            db.scalars(
                select(BackgroundJob).where(
                    BackgroundJob.project_id == project.id,
                    BackgroundJob.job_type == "parse_import",
                )
            )
        )
        jobs_by_batch: dict[str, list[BackgroundJob]] = {}
        for job in relevant_jobs:
            batch_id = job.payload.get("import_batch_id")
            if batch_id:
                jobs_by_batch.setdefault(batch_id, []).append(job)
        for batch in processing_batches:
            jobs = jobs_by_batch.get(batch.id, [])
            if jobs and all(
                job.status in (JobStatus.COMPLETED, JobStatus.FAILED) for job in jobs
            ):
                issues.append(
                    _issue(
                        "import_batch_status_disconnected_from_job",
                        batch.id,
                        "Import batch is still Processing but its job has "
                        "already finished.",
                        severity="repairable",
                    )
                )

    return issues


def reconcile_workflow_integrity(
    db: Session, project: Project, actor_id: str
) -> dict[str, int | bool]:
    """Repair drift the workflow-integrity check can surface.

    The main known cause: a title/abstract decision that used to be INCLUDE
    (and so already queued a FullTextRetrieval row and a full-text
    ScreeningWorkItem) got revised away from INCLUDE. New decisions retract
    that work automatically (see
    conflicts.service.retract_full_text_work_for_publication), but older
    drift -- from before that fix, or from any other path that leaves a
    stray row behind -- needs a one-time sweep. Also retries the full-text ->
    extraction transition and backfills any extraction/quality work items
    still missing for currently-included publications once that's unblocked.
    """
    from app.conflicts.service import (
        invalidate_final_decisions,
        retract_full_text_work_for_publication,
    )
    from app.extraction.reconciliation import attempt_auto_finalize
    from app.fulltext.service import transition_if_full_text_complete
    from app.screening.cohorts import title_abstract_included_ids

    # Exactly one owner: keep the earliest membership that is already marked
    # owner (deterministic, matches the policy the single-owner migration
    # used) and demote any others. A *missing* owner is not auto-repaired --
    # picking who should own the project is not this function's call.
    owners = list(
        db.scalars(
            select(ProjectMembership)
            .where(
                ProjectMembership.project_id == project.id,
                ProjectMembership.is_owner.is_(True),
            )
            .order_by(ProjectMembership.created_at, ProjectMembership.id)
        )
    )
    demoted_owners = 0
    for extra_owner in owners[1:]:
        extra_owner.is_owner = False
        demoted_owners += 1

    # All slots complete, no current FinalExtraction: re-run the same
    # finalization attempt_auto_finalize would already have made had it not
    # lost the race. Idempotent -- if nothing has changed since, it finds the
    # same slots and reaches the same conclusion.
    finalization_attempts = 0
    for issue in project_integrity_issues(db, project):
        if issue["code"] == "extraction_complete_without_final":
            attempt_auto_finalize(db, issue["entityId"])
            finalization_attempts += 1

    # An inactive publication's final decision no longer belongs in the
    # active review -- invalidate it the same way a normal decision revision
    # would, rather than leaving it to silently keep counting.
    invalidated_decisions = 0
    stray_decisions = list(
        db.execute(
            select(FinalDecision.publication_id, FinalDecision.stage)
            .join(Publication, Publication.id == FinalDecision.publication_id)
            .where(
                FinalDecision.project_id == project.id,
                FinalDecision.is_valid.is_(True),
                Publication.is_active.is_(False),
            )
        ).all()
    )
    for publication_id, stage in stray_decisions:
        invalidated_decisions += invalidate_final_decisions(
            db, publication_id, stage, reason="Publication is no longer active"
        )

    # Only the unambiguous case: the job failed, so the batch could not have
    # completed. A batch whose job succeeded but which is still stuck
    # Processing is a different, more ambiguous state left for a human --
    # forcing it to Failed could mislabel data that actually imported fine.
    repaired_import_batches = 0
    stuck_batches = list(
        db.scalars(
            select(ImportBatch).where(
                ImportBatch.project_id == project.id,
                ImportBatch.status == ImportStatus.PROCESSING,
            )
        )
    )
    if stuck_batches:
        failed_jobs = list(
            db.scalars(
                select(BackgroundJob).where(
                    BackgroundJob.project_id == project.id,
                    BackgroundJob.job_type == "parse_import",
                    BackgroundJob.status == JobStatus.FAILED,
                )
            )
        )
        failed_batch_ids = {
            job.payload["import_batch_id"]
            for job in failed_jobs
            if job.payload.get("import_batch_id")
        }
        for batch in stuck_batches:
            if batch.id in failed_batch_ids:
                batch.status = ImportStatus.FAILED
                batch.error_message = (
                    batch.error_message
                    or "Import job failed; status corrected by an integrity repair."
                )
                repaired_import_batches += 1

    currently_included = set(title_abstract_included_ids(db, project.id))
    stray_publication_ids = (
        set(
            db.scalars(
                select(FullTextRetrieval.publication_id).where(
                    FullTextRetrieval.project_id == project.id
                )
            )
        )
        | set(
            db.scalars(
                select(ScreeningWorkItem.publication_id).where(
                    ScreeningWorkItem.project_id == project.id,
                    ScreeningWorkItem.stage == ScreeningStage.FULL_TEXT,
                )
            )
        )
    ) - currently_included

    removed_work_items = 0
    removed_retrievals = 0
    for publication_id in stray_publication_ids:
        item_count, retrieval_count = retract_full_text_work_for_publication(
            db, publication_id
        )
        removed_work_items += item_count
        removed_retrievals += retrieval_count
    db.flush()

    transitioned = False
    if project.stage == ProjectStage.FULL_TEXT:
        transitioned = transition_if_full_text_complete(db, project)

    created_extraction = 0
    created_quality = 0
    if not transitioned and project.stage in (
        ProjectStage.EXTRACTION,
        ProjectStage.COMPLETED,
    ):
        from app.extraction.service import initialize_extraction
        from app.quality.service import initialize_quality

        created_extraction = initialize_extraction(db, project)
        created_quality = initialize_quality(db, project)

    summary = {
        "demotedExtraOwners": demoted_owners,
        "reattemptedFinalizations": finalization_attempts,
        "invalidatedStaleDecisions": invalidated_decisions,
        "repairedImportBatches": repaired_import_batches,
        "removedFullTextWorkItems": removed_work_items,
        "removedFullTextRetrievals": removed_retrievals,
        "advancedToExtraction": transitioned,
        "createdExtractionItems": created_extraction,
        "createdQualityItems": created_quality,
    }
    record_audit(
        db,
        action="project.workflow_integrity_repaired",
        entity_type="project",
        entity_id=project.id,
        project_id=project.id,
        actor_id=actor_id,
        summary="Repaired workflow integrity drift",
        metadata=summary,
    )
    db.flush()
    return summary


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
    db.execute(delete(FinalExtraction).where(FinalExtraction.project_id == project_id))
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
    cancelled_jobs = guard_lifecycle_jobs(
        db, project.id, operation=LifecycleOperation.RESET
    )
    previous_stage = project.stage
    wipe_workflow_data(db, project.id)
    set_project_stage(project, ProjectStage.DRAFT, reason="project reset to draft")
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
        metadata={
            "previousStage": previous_stage.value,
            "cancelledQueuedJobs": cancelled_jobs,
        },
    )
    db.flush()
    return project


def delete_project(db: Session, project: Project) -> None:
    """Permanently delete a project and all of its data, including configuration."""
    guard_lifecycle_jobs(db, project.id, operation=LifecycleOperation.DELETE)
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
