import pytest
from sqlalchemy import select

from app.accounts.service import create_user
from app.analysis.rq_jobs import RQ_SYNTHESIS_JOB
from app.audit.models import AuditEvent
from app.conflicts.models import FinalDecision
from app.conflicts.service import record_final_decision
from app.core.config import get_settings
from app.deduplication.models import PublicationMerge
from app.extraction.models import (
    ExtractionStatus,
    ExtractionWorkItem,
    FinalExtraction,
)
from app.forms.models import FormKind
from app.forms.service import create_form
from app.fulltext.models import FullTextRetrieval, PublicationDocument, RetrievalStatus
from app.imports.models import ImportBatch, ImportStatus
from app.jobs.models import BackgroundJob, JobStatus
from app.llm.models import (
    DocumentTextExtraction,
    ProcessingStatus,
    ProjectLlmSettings,
)
from app.llm.schema_service import project_settings
from app.projects.job_safety import ProjectJobsRunningError
from app.projects.lifecycle import (
    MergeReversalStageError,
    evaluate_project_completion,
    move_project_back,
    project_integrity_issues,
    reconcile_workflow_integrity,
    reopen_project,
    require_merge_reversal_allowed,
    reset_project,
)
from app.projects.models import (
    Project,
    ProjectMembership,
    ProjectStage,
    ResearchQuestion,
    ReviewType,
    ScreeningStage,
)
from app.publications.models import Publication
from app.screening.models import ScreeningWorkItem


def _enable_installation_llm(monkeypatch) -> None:
    settings = get_settings()
    monkeypatch.setattr(settings, "llm_enabled", True)
    monkeypatch.setattr(settings, "ollama_base_url", "http://ollama.example:11434")
    monkeypatch.setattr(settings, "ollama_model", "test-model:latest")
    monkeypatch.setattr(settings, "llm_context_length", 8192)


def create_included_project(db):
    admin = create_user(db, "admin", "Admin", "secret-password", is_admin=True)
    project = Project(
        name="Lifecycle Review",
        review_type=ReviewType.SYSTEMATIC_REVIEW,
        random_seed="seed",
        stage=ProjectStage.EXTRACTION,
    )
    db.add(project)
    db.flush()
    db.add(
        ProjectMembership(project_id=project.id, user_id=admin.id, is_owner=True)
    )
    publication = Publication(project_id=project.id, title="Included publication")
    db.add(publication)
    db.flush()
    record_final_decision(
        db,
        publication.id,
        ScreeningStage.FULL_TEXT,
        "include",
        "agreement",
        None,
        None,
    )
    return admin, project, publication


def complete_extraction_directly(
    db, project, publication, reviewer_id
) -> ExtractionWorkItem:
    """Manufacture a completed extraction outside the normal submit_extraction
    flow, for tests that only care about downstream stage-completion/reopen
    behavior. evaluate_project_completion requires both a COMPLETED work item
    and an authoritative FinalExtraction, so both must be created together."""
    work_item = ExtractionWorkItem(
        project_id=project.id,
        publication_id=publication.id,
        assigned_reviewer_id=reviewer_id,
        random_rank="rank",
        status=ExtractionStatus.COMPLETED,
    )
    db.add(work_item)
    form = create_form(db, "Extraction", FormKind.EXTRACTION, project_id=project.id)
    db.add(
        FinalExtraction(
            project_id=project.id,
            publication_id=publication.id,
            form_version_id=form.active_version_id,
            answers={},
            resolution_method="single_reviewer",
            field_provenance={},
            contributing_response_ids=[],
        )
    )
    db.flush()
    return work_item


def test_project_completes_and_can_be_reopened_without_deleting_work(db) -> None:
    admin, project, publication = create_included_project(db)
    work_item = complete_extraction_directly(db, project, publication, admin.id)

    assert evaluate_project_completion(db, project) is True
    assert project.stage == ProjectStage.COMPLETED
    assert project.completed_at is not None

    reopen_project(db, project, ProjectStage.TITLE_ABSTRACT, admin.id)
    db.commit()
    assert project.stage == ProjectStage.TITLE_ABSTRACT
    assert project.completed_at is None
    assert db.get(ExtractionWorkItem, work_item.id) is not None
    assert {event.action for event in db.query(AuditEvent)} >= {
        "project.completed",
        "project.reopened",
    }


def test_project_completion_queues_rq_synthesis_for_each_research_question(
    db, monkeypatch
) -> None:
    _enable_installation_llm(monkeypatch)
    admin, project, publication = create_included_project(db)
    complete_extraction_directly(db, project, publication, admin.id)
    rq1 = ResearchQuestion(
        project_id=project.id, text="What designs were used?", position=0
    )
    rq2 = ResearchQuestion(
        project_id=project.id, text="What outcomes were measured?", position=1
    )
    db.add_all([rq1, rq2])
    db.flush()

    assert evaluate_project_completion(db, project) is True

    jobs = (
        db.query(BackgroundJob).filter(BackgroundJob.job_type == RQ_SYNTHESIS_JOB).all()
    )
    assert {job.project_id for job in jobs} == {project.id}
    assert len(jobs) == 2


def test_project_completion_skips_rq_synthesis_when_llm_disabled(db) -> None:
    admin, project, publication = create_included_project(db)
    complete_extraction_directly(db, project, publication, admin.id)
    db.add(
        ResearchQuestion(
            project_id=project.id, text="What designs were used?", position=0
        )
    )
    db.flush()

    assert evaluate_project_completion(db, project) is True

    jobs = (
        db.query(BackgroundJob).filter(BackgroundJob.job_type == RQ_SYNTHESIS_JOB).all()
    )
    assert jobs == []


def test_project_completion_skips_rq_synthesis_when_narrative_disabled(
    db, monkeypatch
) -> None:
    _enable_installation_llm(monkeypatch)
    admin, project, publication = create_included_project(db)
    complete_extraction_directly(db, project, publication, admin.id)
    db.add(
        ResearchQuestion(
            project_id=project.id, text="What designs were used?", position=0
        )
    )
    settings = project_settings(db, project.id, create=True)
    settings.analysis_narrative_enabled = False
    db.flush()

    assert evaluate_project_completion(db, project) is True

    jobs = (
        db.query(BackgroundJob).filter(BackgroundJob.job_type == RQ_SYNTHESIS_JOB).all()
    )
    assert jobs == []


def test_project_waits_for_enabled_validation_cohort_but_not_unusable_text(db) -> None:
    admin, project, publication = create_included_project(db)
    complete_extraction_directly(db, project, publication, admin.id)
    document = PublicationDocument(
        project_id=project.id,
        publication_id=publication.id,
        original_filename="paper.pdf",
        storage_key=f"projects/{project.id}/paper.pdf",
        mime_type="application/pdf",
        file_size=100,
        sha256="a" * 64,
        uploaded_by_user_id=admin.id,
    )
    db.add(document)
    db.flush()
    extraction = DocumentTextExtraction(
        document_id=document.id,
        status=ProcessingStatus.PENDING,
        extractor="pypdf",
        extractor_version="1",
    )
    db.add(extraction)
    db.add(
        ProjectLlmSettings(
            project_id=project.id,
            extraction_validation_enabled=True,
        )
    )
    db.flush()

    assert evaluate_project_completion(db, project) is False
    assert project.stage == ProjectStage.EXTRACTION

    extraction.status = ProcessingStatus.UNSUPPORTED
    db.flush()
    assert evaluate_project_completion(db, project) is True
    assert project.stage == ProjectStage.COMPLETED


def test_project_cannot_complete_while_late_full_text_work_is_outstanding(db) -> None:
    admin, project, included = create_included_project(db)
    complete_extraction_directly(db, project, included, admin.id)
    reconsidered = Publication(project_id=project.id, title="Reconsidered paper")
    db.add(reconsidered)
    db.flush()
    record_final_decision(
        db,
        reconsidered.id,
        ScreeningStage.TITLE_ABSTRACT,
        "include",
        "revised_consensus",
        admin.id,
        None,
    )

    assert evaluate_project_completion(db, project) is False
    assert project.stage == ProjectStage.EXTRACTION


def test_move_project_back_deletes_downstream_data_and_resets_target_stage(db) -> None:
    admin, project, publication = create_included_project(db)
    work_item = complete_extraction_directly(db, project, publication, admin.id)
    db.commit()

    move_project_back(db, project, ProjectStage.TITLE_ABSTRACT, admin.id)
    db.commit()

    assert project.stage == ProjectStage.TITLE_ABSTRACT
    # Downstream extraction work and the full-text final decision are wiped.
    assert db.get(ExtractionWorkItem, work_item.id) is None
    assert db.query(FinalExtraction).count() == 0
    assert (
        db.query(FinalDecision)
        .filter(FinalDecision.stage == ScreeningStage.FULL_TEXT)
        .first()
        is None
    )
    assert "project.moved_back" in {event.action for event in db.query(AuditEvent)}


def test_move_project_back_rejects_draft_and_completed_projects(db) -> None:
    admin, project, _publication = create_included_project(db)

    project.stage = ProjectStage.DRAFT
    with pytest.raises(ValueError):
        move_project_back(db, project, ProjectStage.DRAFT, admin.id)

    project.stage = ProjectStage.COMPLETED
    with pytest.raises(ValueError):
        move_project_back(db, project, ProjectStage.TITLE_ABSTRACT, admin.id)


def test_move_project_back_rejects_a_later_or_equal_target_stage(db) -> None:
    admin, project, _publication = create_included_project(db)
    project.stage = ProjectStage.FULL_TEXT

    with pytest.raises(ValueError):
        move_project_back(db, project, ProjectStage.EXTRACTION, admin.id)
    with pytest.raises(ValueError):
        move_project_back(db, project, ProjectStage.FULL_TEXT, admin.id)


def test_completion_ignores_a_publication_removed_from_the_review(db) -> None:
    """A deleted publication must not hold a project open forever.

    Its extraction slot is retracted on removal, and it leaves the included
    cohort -- so the project can complete on the publications that are
    actually still under review."""
    from app.publications.deletion import remove_publications_from_review

    admin, project, publication = create_included_project(db)
    complete_extraction_directly(db, project, publication, admin.id)
    removed = Publication(project_id=project.id, title="Withdrawn paper")
    db.add(removed)
    db.flush()
    record_final_decision(
        db, removed.id, ScreeningStage.FULL_TEXT, "include", "agreement", None, None
    )
    db.flush()
    # The full-text INCLUDE enrolled it in extraction; nobody has filled that
    # slot in.
    outstanding = db.scalar(
        select(ExtractionWorkItem).where(
            ExtractionWorkItem.publication_id == removed.id
        )
    )
    assert outstanding is not None
    assert outstanding.status != ExtractionStatus.COMPLETED

    # While it is part of the review, its outstanding slot rightly blocks
    # completion.
    assert evaluate_project_completion(db, project) is False

    remove_publications_from_review(db, project.id, [removed])
    db.flush()

    assert evaluate_project_completion(db, project) is True
    assert project.stage == ProjectStage.COMPLETED


def _job(project, job_type: str, status: JobStatus) -> BackgroundJob:
    return BackgroundJob(
        project_id=project.id, job_type=job_type, payload={}, status=status
    )


def test_reset_is_refused_while_an_import_job_is_running(db) -> None:
    """A running handler commits into the project long after the request that
    queued it returned, so wiping the project under it would resurrect state
    the reset had just deleted."""
    admin, project, publication = create_included_project(db)
    running = _job(project, "parse_import", JobStatus.RUNNING)
    db.add(running)
    db.flush()

    with pytest.raises(ProjectJobsRunningError) as raised:
        reset_project(db, project, admin.id)

    assert raised.value.status_code == 409
    assert raised.value.code == "project_jobs_running"
    assert raised.value.details == {
        "operation": "reset",
        "runningJobCount": 1,
        "runningJobTypes": ["parse_import"],
    }
    # Nothing was touched: the project keeps its stage, its publications, and
    # the running job's row (deleting it would not stop the handler).
    assert project.stage == ProjectStage.EXTRACTION
    assert db.get(Publication, publication.id) is not None
    assert db.get(BackgroundJob, running.id).status == JobStatus.RUNNING


def test_move_back_is_refused_while_an_llm_job_is_running(db) -> None:
    admin, project, _publication = create_included_project(db)
    running = _job(project, RQ_SYNTHESIS_JOB, JobStatus.RUNNING)
    db.add(running)
    db.flush()

    with pytest.raises(ProjectJobsRunningError) as raised:
        move_project_back(db, project, ProjectStage.TITLE_ABSTRACT, admin.id)

    assert raised.value.details["operation"] == "move_back"
    assert raised.value.details["runningJobTypes"] == [RQ_SYNTHESIS_JOB]
    assert project.stage == ProjectStage.EXTRACTION
    assert (
        db.query(FinalDecision)
        .filter(FinalDecision.stage == ScreeningStage.FULL_TEXT)
        .count()
        == 1
    )


def test_move_back_cancels_queued_jobs_and_leaves_finished_ones_alone(db) -> None:
    admin, project, _publication = create_included_project(db)
    queued = _job(project, "generate_export", JobStatus.QUEUED)
    completed = _job(project, "parse_import", JobStatus.COMPLETED)
    failed = _job(project, "enrich_publication", JobStatus.FAILED)
    db.add_all([queued, completed, failed])
    db.flush()

    move_project_back(db, project, ProjectStage.TITLE_ABSTRACT, admin.id)
    db.commit()

    assert project.stage == ProjectStage.TITLE_ABSTRACT
    # Queued work has not started, so cancelling it is safe -- and is the only
    # way the rewind can proceed without the job later running against state
    # that no longer exists.
    assert db.get(BackgroundJob, queued.id).status == JobStatus.CANCELLED
    assert db.get(BackgroundJob, completed.id).status == JobStatus.COMPLETED
    assert db.get(BackgroundJob, failed.id).status == JobStatus.FAILED
    moved_back = next(
        event for event in db.query(AuditEvent) if event.action == "project.moved_back"
    )
    assert moved_back.event_metadata["cancelledQueuedJobs"] == 1


def test_reset_proceeds_when_only_finished_jobs_exist(db) -> None:
    admin, project, publication = create_included_project(db)
    db.add_all(
        [
            _job(project, "parse_import", JobStatus.COMPLETED),
            _job(project, "generate_export", JobStatus.CANCELLED),
        ]
    )
    db.flush()

    reset_project(db, project, admin.id)
    db.commit()

    assert project.stage == ProjectStage.DRAFT
    assert db.get(Publication, publication.id) is None


def test_merge_reversal_is_refused_once_the_project_left_duplicate_review(db) -> None:
    _admin, project, publication = create_included_project(db)
    merge_from_duplicate_review = PublicationMerge(
        stage_at_merge=ProjectStage.DUPLICATE_REVIEW.value,
        merged_publication_id=publication.id,
    )

    with pytest.raises(MergeReversalStageError) as raised:
        require_merge_reversal_allowed(db, project, merge_from_duplicate_review)

    assert raised.value.status_code == 409
    assert raised.value.code == "merge_reversal_stage_locked"
    assert raised.value.details == {
        "projectStage": ProjectStage.EXTRACTION.value,
        "requiredStage": ProjectStage.DUPLICATE_REVIEW.value,
    }


def test_merge_reversal_during_duplicate_review_still_checks_running_jobs(db) -> None:
    _admin, project, _publication = create_included_project(db)
    project.stage = ProjectStage.DUPLICATE_REVIEW
    db.add(_job(project, "detect_duplicates", JobStatus.RUNNING))
    db.flush()

    with pytest.raises(ProjectJobsRunningError) as raised:
        require_merge_reversal_allowed(db, project)

    assert raised.value.details["operation"] == "undo_merge"


def test_integrity_check_detects_missing_downstream_work(db) -> None:
    _, project, publication = create_included_project(db)
    issues = project_integrity_issues(db, project)
    assert {(issue["code"], issue["entityId"]) for issue in issues} == {
        ("missing_extraction_item", publication.id)
    }


def test_integrity_check_ignores_downstream_items_until_full_text_stage_finishes(
    db,
) -> None:
    project = Project(
        name="Retrievals still open",
        review_type=ReviewType.SYSTEMATIC_REVIEW,
        random_seed="seed",
        stage=ProjectStage.FULL_TEXT,
    )
    db.add(project)
    db.flush()
    screened = Publication(project_id=project.id, title="Screened full text")
    awaiting_retrieval = Publication(project_id=project.id, title="Awaiting retrieval")
    db.add_all([screened, awaiting_retrieval])
    db.flush()

    for publication in (screened, awaiting_retrieval):
        record_final_decision(
            db,
            publication.id,
            ScreeningStage.TITLE_ABSTRACT,
            "include",
            "agreement",
            None,
            None,
        )
    record_final_decision(
        db,
        screened.id,
        ScreeningStage.FULL_TEXT,
        "include",
        "agreement",
        None,
        None,
    )
    db.flush()

    issue_codes = {issue["code"] for issue in project_integrity_issues(db, project)}

    assert "missing_extraction_item" not in issue_codes
    assert "missing_quality_item" not in issue_codes
    assert db.query(ExtractionWorkItem).count() == 0


def test_reconcile_workflow_integrity_backfills_missing_extraction_item(db) -> None:
    admin, project, publication = create_included_project(db)
    create_form(db, "Extraction", FormKind.EXTRACTION, project_id=project.id)
    db.commit()
    assert project_integrity_issues(db, project) != []

    result = reconcile_workflow_integrity(db, project, admin.id)
    db.commit()

    assert result["createdExtractionItems"] == 1
    assert "missing_extraction_item" not in {
        issue["code"] for issue in project_integrity_issues(db, project)
    }
    assert (
        db.query(ExtractionWorkItem).filter_by(publication_id=publication.id).count()
        == 1
    )
    assert "project.workflow_integrity_repaired" in {
        event.action for event in db.query(AuditEvent)
    }


def test_reconcile_workflow_integrity_clears_stray_full_text_work(db) -> None:
    admin, project, _publication = create_included_project(db)
    stray = Publication(project_id=project.id, title="Stray")
    db.add(stray)
    db.flush()
    db.add(
        FullTextRetrieval(
            project_id=project.id,
            publication_id=stray.id,
            status=RetrievalStatus.NOT_YET_SOUGHT,
        )
    )
    db.add(
        ScreeningWorkItem(
            project_id=project.id,
            publication_id=stray.id,
            stage=ScreeningStage.FULL_TEXT,
            slot_number=1,
            random_rank="rank",
        )
    )
    db.commit()

    result = reconcile_workflow_integrity(db, project, admin.id)
    db.commit()

    assert result["removedFullTextRetrievals"] == 1
    assert result["removedFullTextWorkItems"] == 1
    assert db.query(FullTextRetrieval).filter_by(publication_id=stray.id).count() == 0
    assert db.query(ScreeningWorkItem).filter_by(publication_id=stray.id).count() == 0


def test_integrity_check_detects_zero_and_multiple_owners(db) -> None:
    admin, project, publication = create_included_project(db)
    create_form(db, "Extraction", FormKind.EXTRACTION, project_id=project.id)
    db.commit()

    # create_included_project already gave this project exactly one owner.
    codes = {issue["code"] for issue in project_integrity_issues(db, project)}
    assert "no_project_owner" not in codes
    assert "multiple_project_owners" not in codes

    owner_membership = db.scalar(
        select(ProjectMembership).where(
            ProjectMembership.project_id == project.id,
            ProjectMembership.user_id == admin.id,
        )
    )
    owner_membership.is_owner = False
    db.commit()
    assert "no_project_owner" in {
        issue["code"] for issue in project_integrity_issues(db, project)
    }
    owner_membership.is_owner = True
    db.commit()

    # A second concurrent owner cannot actually be inserted here:
    # uq_project_single_owner (the partial unique index the ownership
    # migration added) enforces "at most one" at the database level, so this
    # test DB -- built fresh from current models, not by replaying history --
    # can never reach that state through an ordinary insert. The
    # multiple_project_owners check and its repair exist for a database from
    # before that index existed; verified directly against the detection
    # logic's SQL by inserting the second owner with the index dropped.
    from sqlalchemy import text

    db.execute(text("DROP INDEX uq_project_single_owner"))
    second = create_user(db, "second-owner", "Second", "secret-password")
    db.add(
        ProjectMembership(project_id=project.id, user_id=second.id, is_owner=True)
    )
    db.commit()
    assert "multiple_project_owners" in {
        issue["code"] for issue in project_integrity_issues(db, project)
    }

    reconcile_workflow_integrity(db, project, admin.id)
    db.commit()

    remaining_owners = list(
        db.scalars(
            select(ProjectMembership).where(
                ProjectMembership.project_id == project.id,
                ProjectMembership.is_owner.is_(True),
            )
        )
    )
    assert len(remaining_owners) == 1
    # The earlier membership (admin's) is kept, matching the single-owner
    # migration's own "keep earliest" policy.
    assert remaining_owners[0].user_id == admin.id
    assert "multiple_project_owners" not in {
        issue["code"] for issue in project_integrity_issues(db, project)
    }


def test_integrity_check_detects_and_repairs_inactive_publication_in_cohort(
    db,
) -> None:
    admin, project, publication = create_included_project(db)
    create_form(db, "Extraction", FormKind.EXTRACTION, project_id=project.id)
    db.commit()

    # Simulate drift from before remove_publications_from_review existed: the
    # publication was deactivated directly, without retracting its decision.
    publication.is_active = False
    db.commit()

    issues = project_integrity_issues(db, project)
    assert (
        "inactive_publication_in_cohort",
        publication.id,
    ) in {(issue["code"], issue["entityId"]) for issue in issues}

    result = reconcile_workflow_integrity(db, project, admin.id)
    db.commit()

    assert result["invalidatedStaleDecisions"] >= 1
    remaining = db.scalar(
        select(FinalDecision).where(
            FinalDecision.publication_id == publication.id,
            FinalDecision.is_valid.is_(True),
        )
    )
    assert remaining is None
    assert "inactive_publication_in_cohort" not in {
        issue["code"] for issue in project_integrity_issues(db, project)
    }


def test_integrity_check_detects_and_repairs_disconnected_import_batch(db) -> None:
    admin, project, _publication = create_included_project(db)
    batch = ImportBatch(
        project_id=project.id,
        original_filename="refs.ris",
        stored_path="/tmp/refs.ris",
        file_type="ris",
        status=ImportStatus.PROCESSING,
        created_by_id=admin.id,
    )
    db.add(batch)
    db.flush()
    failed_job = BackgroundJob(
        project_id=project.id,
        job_type="parse_import",
        payload={"import_batch_id": batch.id},
        status=JobStatus.FAILED,
    )
    db.add(failed_job)
    db.commit()

    issues = project_integrity_issues(db, project)
    assert (
        "import_batch_status_disconnected_from_job",
        batch.id,
    ) in {(issue["code"], issue["entityId"]) for issue in issues}

    result = reconcile_workflow_integrity(db, project, admin.id)
    db.commit()

    assert result["repairedImportBatches"] == 1
    db.refresh(batch)
    assert batch.status == ImportStatus.FAILED
    assert "import_batch_status_disconnected_from_job" not in {
        issue["code"] for issue in project_integrity_issues(db, project)
    }


def test_integrity_check_does_not_repair_a_batch_whose_job_is_still_running(
    db,
) -> None:
    """A batch stuck Processing with an active (queued/running) job is not
    disconnected -- it might just be slow. Only a terminally failed job with
    no batch-status update is unambiguous."""
    admin, project, _publication = create_included_project(db)
    batch = ImportBatch(
        project_id=project.id,
        original_filename="refs.ris",
        stored_path="/tmp/refs.ris",
        file_type="ris",
        status=ImportStatus.PROCESSING,
        created_by_id=admin.id,
    )
    db.add(batch)
    db.flush()
    db.add(
        BackgroundJob(
            project_id=project.id,
            job_type="parse_import",
            payload={"import_batch_id": batch.id},
            status=JobStatus.RUNNING,
        )
    )
    db.commit()

    assert "import_batch_status_disconnected_from_job" not in {
        issue["code"] for issue in project_integrity_issues(db, project)
    }

    reconcile_workflow_integrity(db, project, admin.id)
    db.commit()
    db.refresh(batch)
    assert batch.status == ImportStatus.PROCESSING
