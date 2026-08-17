from sqlalchemy import select

from app.accounts.service import create_user
from app.audit.models import AuditEvent
from app.conflicts.models import FinalDecision
from app.conflicts.service import (
    record_final_decision,
    refresh_automatic_final_decision,
    transition_if_screening_complete,
)
from app.extraction.models import ExtractionStatus, ExtractionWorkItem
from app.fulltext.models import (
    FullTextRetrieval,
    PublicationDocument,
    RetrievalStatus,
)
from app.jobs.models import BackgroundJob, JobStatus
from app.llm.models import ProjectLlmSettings
from app.projects.lifecycle import evaluate_project_completion
from app.projects.models import (
    AllocationMode,
    Criterion,
    CriterionKind,
    Project,
    ProjectMembership,
    ProjectStage,
    ReviewType,
    ScreeningConfig,
    ScreeningStage,
)
from app.publications.models import Publication
from app.publications.service import sync_new_publications_with_stage
from app.screening.models import ScreeningWorkItem
from app.screening.service import (
    claim_next_work_item,
    create_screening_work_items,
    submit_decision,
)


def setup_conflict(db, second_outcome: str = "exclude"):
    admin = create_user(db, "admin", "Admin", "secret-password", is_admin=True)
    r1 = create_user(db, "r1", "R1", "password-1")
    r2 = create_user(db, "r2", "R2", "password-2")
    project = Project(
        name="Review",
        review_type=ReviewType.SYSTEMATIC_REVIEW,
        random_seed="seed",
        stage=ProjectStage.TITLE_ABSTRACT,
    )
    db.add(project)
    db.flush()
    for reviewer in (r1, r2):
        db.add(
            ProjectMembership(
                project_id=project.id,
                user_id=reviewer.id,
                can_title_abstract_screen=True,
            )
        )
    db.add(
        ScreeningConfig(
            project_id=project.id,
            stage=ScreeningStage.TITLE_ABSTRACT,
            required_reviewers=2,
            allocation_mode=AllocationMode.INDEPENDENT,
        )
    )
    criterion = Criterion(
        project_id=project.id, kind=CriterionKind.INCLUSION, text="Relevant", position=0
    )
    publication = Publication(project_id=project.id, title="Paper")
    db.add_all([criterion, publication])
    db.flush()
    create_screening_work_items(db, project, ScreeningStage.TITLE_ABSTRACT)
    db.commit()
    items = []
    for reviewer in (r1, r2):
        item = claim_next_work_item(
            db, project.id, ScreeningStage.TITLE_ABSTRACT, reviewer.id
        )
        items.append(item)
    submit_decision(db, items[0], r1.id, "include", {criterion.id: True}, None)
    submit_decision(
        db,
        items[1],
        r2.id,
        second_outcome,
        {criterion.id: True},
        None,
    )
    db.commit()
    return admin, project, publication, r1, r2, items, criterion


def test_conflict_requires_separate_final_consensus(db) -> None:
    admin, project, publication, *_ = setup_conflict(db)
    assert (
        refresh_automatic_final_decision(
            db, publication.id, ScreeningStage.TITLE_ABSTRACT
        )
        is None
    )
    final = record_final_decision(
        db,
        publication.id,
        ScreeningStage.TITLE_ABSTRACT,
        "include",
        "admin_consensus",
        admin.id,
        "Agreed after discussion",
    )
    db.commit()
    assert final.outcome.value == "include"
    assert final.note == "Agreed after discussion"
    assert (
        transition_if_screening_complete(db, project, ScreeningStage.TITLE_ABSTRACT)
        is True
    )
    assert project.stage == ProjectStage.FULL_TEXT


def test_agreement_creates_automatic_final_decision(db) -> None:
    _, project, publication, *_ = setup_conflict(db, second_outcome="include")
    final = refresh_automatic_final_decision(
        db, publication.id, ScreeningStage.TITLE_ABSTRACT
    )
    db.commit()
    assert final is not None
    assert final.resolution_method == "agreement"
    assert (
        transition_if_screening_complete(db, project, ScreeningStage.TITLE_ABSTRACT)
        is True
    )


def test_revision_invalidates_existing_consensus(db) -> None:
    admin, _, publication, r1, _, items, criterion = setup_conflict(db)
    final = record_final_decision(
        db,
        publication.id,
        ScreeningStage.TITLE_ABSTRACT,
        "include",
        "admin_consensus",
        admin.id,
        None,
    )
    db.commit()
    submit_decision(db, items[0], r1.id, "uncertain", {criterion.id: True}, "changed")
    db.commit()
    db.refresh(final)
    assert final.is_valid is False
    assert final.invalidated_at is not None


def test_late_title_abstract_inclusion_backfills_review_and_background_work(
    db, monkeypatch
) -> None:
    from app.core.config import get_settings

    settings = get_settings()
    monkeypatch.setattr(settings, "llm_enabled", True)
    monkeypatch.setattr(settings, "ollama_model", "test-model:latest")

    admin = create_user(db, "late-admin", "Late Admin", "secret-password")
    reviewer = create_user(db, "late-reviewer", "Late Reviewer", "password-1")
    project = Project(
        name="Late inclusion",
        review_type=ReviewType.SYSTEMATIC_REVIEW,
        random_seed="late-seed",
        stage=ProjectStage.EXTRACTION,
    )
    db.add(project)
    db.flush()
    db.add(
        ProjectMembership(
            project_id=project.id,
            user_id=reviewer.id,
            can_full_text_screen=True,
        )
    )
    db.add(
        ScreeningConfig(
            project_id=project.id,
            stage=ScreeningStage.FULL_TEXT,
            required_reviewers=1,
            allocation_mode=AllocationMode.INDEPENDENT,
        )
    )
    db.add(
        ProjectLlmSettings(
            project_id=project.id,
            full_text_screening_enabled=True,
        )
    )
    publication = Publication(project_id=project.id, title="Reconsidered paper")
    db.add(publication)
    db.flush()
    document = PublicationDocument(
        project_id=project.id,
        publication_id=publication.id,
        original_filename="reconsidered.pdf",
        storage_key=f"projects/{project.id}/reconsidered.pdf",
        mime_type="application/pdf",
        file_size=100,
        sha256="a" * 64,
        uploaded_by_user_id=admin.id,
    )
    db.add(document)
    record_final_decision(
        db,
        publication.id,
        ScreeningStage.TITLE_ABSTRACT,
        "exclude",
        "agreement",
        admin.id,
        None,
    )
    db.flush()

    record_final_decision(
        db,
        publication.id,
        ScreeningStage.TITLE_ABSTRACT,
        "include",
        "revised_consensus",
        admin.id,
        "Reconsidered after title/abstract screening",
    )
    # The revised publication enters downstream work immediately without the
    # completed title/abstract stage rewinding the project.
    assert (
        transition_if_screening_complete(db, project, ScreeningStage.TITLE_ABSTRACT)
        is False
    )
    db.commit()

    assert project.stage == ProjectStage.EXTRACTION

    retrieval = db.scalar(
        select(FullTextRetrieval).where(
            FullTextRetrieval.publication_id == publication.id
        )
    )
    assert retrieval is not None
    assert retrieval.status == RetrievalStatus.AVAILABLE

    item = db.scalar(
        select(ScreeningWorkItem).where(
            ScreeningWorkItem.publication_id == publication.id,
            ScreeningWorkItem.stage == ScreeningStage.FULL_TEXT,
        )
    )
    assert item is not None
    assert item.assigned_reviewer_id == reviewer.id

    jobs = list(
        db.scalars(
            select(BackgroundJob).where(
                BackgroundJob.project_id == project.id,
                BackgroundJob.status == JobStatus.QUEUED,
            )
        )
    )
    assert any(
        job.job_type == "extract_document_text"
        and job.payload["document_id"] == document.id
        for job in jobs
    )


def test_publication_added_after_full_text_started_backfills_on_first_decision(
    db,
) -> None:
    """A newly added publication's *first* title/abstract decision is just as
    "late" as a revised one -- the backfill must not only fire on revisions."""
    create_user(db, "admin", "Admin", "secret-password", is_admin=True)
    reviewer = create_user(db, "reviewer", "Reviewer", "password-1")
    project = Project(
        name="Late addition",
        review_type=ReviewType.SYSTEMATIC_REVIEW,
        random_seed="seed",
        stage=ProjectStage.FULL_TEXT,
    )
    db.add(project)
    db.flush()
    db.add(
        ProjectMembership(
            project_id=project.id,
            user_id=reviewer.id,
            can_title_abstract_screen=True,
        )
    )
    db.add(
        ScreeningConfig(
            project_id=project.id,
            stage=ScreeningStage.TITLE_ABSTRACT,
            required_reviewers=1,
            allocation_mode=AllocationMode.INDEPENDENT,
        )
    )
    criterion = Criterion(
        project_id=project.id, kind=CriterionKind.INCLUSION, text="Relevant", position=0
    )
    publication = Publication(project_id=project.id, title="Added late")
    db.add_all([criterion, publication])
    db.flush()

    sync_new_publications_with_stage(db, project, [publication.id])
    db.commit()

    item = claim_next_work_item(
        db, project.id, ScreeningStage.TITLE_ABSTRACT, reviewer.id
    )
    assert item is not None
    submit_decision(db, item, reviewer.id, "include", {criterion.id: True}, None)
    refresh_automatic_final_decision(db, publication.id, ScreeningStage.TITLE_ABSTRACT)
    db.commit()

    retrieval = db.scalar(
        select(FullTextRetrieval).where(
            FullTextRetrieval.publication_id == publication.id
        )
    )
    assert retrieval is not None
    assert project.stage == ProjectStage.FULL_TEXT


def test_late_addition_to_a_completed_project_reopens_it_until_it_finishes(db) -> None:
    admin = create_user(db, "admin", "Admin", "secret-password", is_admin=True)
    reviewer = create_user(db, "reviewer", "Reviewer", "password-1")
    project = Project(
        name="Completed review",
        review_type=ReviewType.SYSTEMATIC_REVIEW,
        random_seed="seed",
        stage=ProjectStage.EXTRACTION,
    )
    db.add(project)
    db.flush()
    included = Publication(project_id=project.id, title="Already finished paper")
    db.add(included)
    db.flush()
    record_final_decision(
        db, included.id, ScreeningStage.FULL_TEXT, "include", "agreement", None, None
    )
    db.add(
        ExtractionWorkItem(
            project_id=project.id,
            publication_id=included.id,
            assigned_reviewer_id=admin.id,
            random_rank="rank",
            status=ExtractionStatus.COMPLETED,
        )
    )
    db.flush()
    assert evaluate_project_completion(db, project) is True
    assert project.stage == ProjectStage.COMPLETED
    assert project.completed_at is not None

    db.add(
        ProjectMembership(
            project_id=project.id,
            user_id=reviewer.id,
            can_title_abstract_screen=True,
        )
    )
    db.add(
        ScreeningConfig(
            project_id=project.id,
            stage=ScreeningStage.TITLE_ABSTRACT,
            required_reviewers=1,
            allocation_mode=AllocationMode.INDEPENDENT,
        )
    )
    criterion = Criterion(
        project_id=project.id, kind=CriterionKind.INCLUSION, text="Relevant", position=0
    )
    late_arrival = Publication(project_id=project.id, title="Added after completion")
    db.add_all([criterion, late_arrival])
    db.flush()

    sync_new_publications_with_stage(db, project, [late_arrival.id])
    db.commit()

    item = claim_next_work_item(
        db, project.id, ScreeningStage.TITLE_ABSTRACT, reviewer.id
    )
    assert item is not None
    submit_decision(db, item, reviewer.id, "include", {criterion.id: True}, None)
    refresh_automatic_final_decision(
        db, late_arrival.id, ScreeningStage.TITLE_ABSTRACT
    )
    db.commit()

    # The project is genuinely no longer complete: real work is outstanding
    # for the new publication.
    assert project.stage == ProjectStage.FULL_TEXT
    assert project.completed_at is None
    retrieval = db.scalar(
        select(FullTextRetrieval).where(
            FullTextRetrieval.publication_id == late_arrival.id
        )
    )
    assert retrieval is not None

    # The already-finished publication's history is untouched.
    already_finished_extraction = db.scalar(
        select(ExtractionWorkItem).where(
            ExtractionWorkItem.publication_id == included.id
        )
    )
    assert already_finished_extraction.status == ExtractionStatus.COMPLETED


def test_late_addition_to_completed_project_records_audit_and_regenerates_analysis(
    db,
) -> None:
    """Reopening a completed project for a late-added publication should be
    traceable (an audit event) and should refresh the title/abstract analysis
    once that publication's screening decision settles the picture again."""
    admin = create_user(db, "admin", "Admin", "secret-password", is_admin=True)
    reviewer = create_user(db, "reviewer", "Reviewer", "password-1")
    project = Project(
        name="Completed review",
        review_type=ReviewType.SYSTEMATIC_REVIEW,
        random_seed="seed",
        stage=ProjectStage.EXTRACTION,
    )
    db.add(project)
    db.flush()
    included = Publication(project_id=project.id, title="Already finished paper")
    db.add(included)
    db.flush()
    # Recorded directly (not via record_final_decision) so this pre-existing
    # title/abstract inclusion doesn't itself trigger the late-inclusion
    # backfill this test is targeting at the newly-added publication below.
    db.add(
        FinalDecision(
            project_id=project.id,
            publication_id=included.id,
            stage=ScreeningStage.TITLE_ABSTRACT,
            outcome="include",
            resolution_method="agreement",
            is_valid=True,
        )
    )
    db.add(
        FullTextRetrieval(
            project_id=project.id,
            publication_id=included.id,
            status=RetrievalStatus.AVAILABLE,
        )
    )
    record_final_decision(
        db, included.id, ScreeningStage.FULL_TEXT, "include", "agreement", None, None
    )
    db.add(
        ExtractionWorkItem(
            project_id=project.id,
            publication_id=included.id,
            assigned_reviewer_id=admin.id,
            random_rank="rank",
            status=ExtractionStatus.COMPLETED,
        )
    )
    db.flush()
    assert evaluate_project_completion(db, project) is True
    assert project.stage == ProjectStage.COMPLETED

    db.add(
        ProjectMembership(
            project_id=project.id,
            user_id=reviewer.id,
            can_title_abstract_screen=True,
        )
    )
    db.add(
        ScreeningConfig(
            project_id=project.id,
            stage=ScreeningStage.TITLE_ABSTRACT,
            required_reviewers=1,
            allocation_mode=AllocationMode.INDEPENDENT,
        )
    )
    criterion = Criterion(
        project_id=project.id, kind=CriterionKind.INCLUSION, text="Relevant", position=0
    )
    late_arrival = Publication(project_id=project.id, title="Added after completion")
    db.add_all([criterion, late_arrival])
    db.flush()

    sync_new_publications_with_stage(db, project, [late_arrival.id])
    db.commit()

    item = claim_next_work_item(
        db, project.id, ScreeningStage.TITLE_ABSTRACT, reviewer.id
    )
    assert item is not None
    submit_decision(db, item, reviewer.id, "include", {criterion.id: True}, None)
    refresh_automatic_final_decision(
        db, late_arrival.id, ScreeningStage.TITLE_ABSTRACT
    )
    db.commit()

    reopen_event = db.scalar(
        select(AuditEvent).where(
            AuditEvent.project_id == project.id,
            AuditEvent.action == "project.reopened_for_late_inclusion",
        )
    )
    assert reopen_event is not None
    assert reopen_event.event_metadata["publicationId"] == late_arrival.id

    analysis_jobs = list(
        db.scalars(
            select(BackgroundJob).where(
                BackgroundJob.project_id == project.id,
                BackgroundJob.job_type == "generate_stage_analysis",
                BackgroundJob.status == JobStatus.QUEUED,
            )
        )
    )
    assert any(
        job.payload["stage"] == "title_abstract_screening" for job in analysis_jobs
    )


def test_inclusion_immediately_queues_retrieval_before_stage_transition(db) -> None:
    """A title/abstract INCLUDE must get a retrieval row and an automatic
    browser-retrieval job as soon as it's decided, without waiting for the
    whole project to finish title/abstract screening and transition to the
    full-text stage."""
    from app.pdf_acquisition.models import BrowserAgent, PdfRetrievalJob, RetrievalJobStatus

    admin, project, publication, r1, r2, items, criterion = setup_conflict(
        db, second_outcome="include"
    )
    membership = db.scalar(
        select(ProjectMembership).where(
            ProjectMembership.project_id == project.id,
            ProjectMembership.user_id == r1.id,
        )
    )
    membership.can_full_text_screen = True
    db.add(BrowserAgent(user_id=r1.id, display_name="R1's Chrome", token_hash="x" * 64))
    db.commit()

    final = refresh_automatic_final_decision(
        db, publication.id, ScreeningStage.TITLE_ABSTRACT
    )
    db.commit()
    assert final is not None
    assert project.stage == ProjectStage.TITLE_ABSTRACT

    retrieval = db.scalar(
        select(FullTextRetrieval).where(
            FullTextRetrieval.publication_id == publication.id
        )
    )
    assert retrieval is not None
    assert retrieval.status == RetrievalStatus.NOT_YET_SOUGHT

    job = db.scalar(
        select(PdfRetrievalJob).where(PdfRetrievalJob.publication_id == publication.id)
    )
    assert job is not None
    assert job.status == RetrievalJobStatus.QUEUED
    assert job.batch.created_by_user_id == r1.id


def test_inclusion_without_any_paired_agent_skips_auto_queue(db) -> None:
    from app.pdf_acquisition.models import PdfRetrievalJob

    _, project, publication, *_ = setup_conflict(db, second_outcome="include")
    final = refresh_automatic_final_decision(
        db, publication.id, ScreeningStage.TITLE_ABSTRACT
    )
    db.commit()
    assert final is not None

    retrieval = db.scalar(
        select(FullTextRetrieval).where(
            FullTextRetrieval.publication_id == publication.id
        )
    )
    assert retrieval is not None
    assert retrieval.status == RetrievalStatus.NOT_YET_SOUGHT
    assert (
        db.scalar(
            select(PdfRetrievalJob).where(
                PdfRetrievalJob.publication_id == publication.id
            )
        )
        is None
    )


def test_list_conflicts_includes_publication_and_reviewer_decisions(client, db) -> None:
    _, project, publication, *_ = setup_conflict(db)

    csrf = client.post(
        "/api/v1/auth/login",
        json={"username": "admin", "password": "secret-password"},
    ).json()["csrfToken"]
    response = client.get(
        f"/api/v1/projects/{project.id}/screening/title_abstract/conflicts",
        headers={"X-CSRF-Token": csrf},
    )

    assert response.status_code == 200
    [conflict] = response.json()
    assert conflict["publicationId"] == publication.id
    assert conflict["publication"]["title"] == "Paper"

    decisions_by_reviewer = {
        decision["reviewer"]["displayName"]: decision
        for decision in conflict["decisions"]
    }
    assert decisions_by_reviewer["R1"]["outcome"] == "include"
    assert decisions_by_reviewer["R2"]["outcome"] == "exclude"


def test_list_conflicts_excludes_publications_still_awaiting_decisions(
    client, db
) -> None:
    create_user(db, "admin3", "Admin3", "secret-password", is_admin=True)
    r1 = create_user(db, "r1c", "R1c", "password-1")
    project = Project(
        name="Untouched",
        review_type=ReviewType.SYSTEMATIC_REVIEW,
        random_seed="seed3",
        stage=ProjectStage.TITLE_ABSTRACT,
    )
    db.add(project)
    db.flush()
    db.add(
        ProjectMembership(
            project_id=project.id, user_id=r1.id, can_title_abstract_screen=True
        )
    )
    db.add(
        ScreeningConfig(
            project_id=project.id,
            stage=ScreeningStage.TITLE_ABSTRACT,
            required_reviewers=1,
            allocation_mode=AllocationMode.INDEPENDENT,
        )
    )
    criterion = Criterion(
        project_id=project.id, kind=CriterionKind.INCLUSION, text="Relevant", position=0
    )
    publication = Publication(project_id=project.id, title="Untouched Paper")
    db.add_all([criterion, publication])
    db.flush()
    create_screening_work_items(db, project, ScreeningStage.TITLE_ABSTRACT)
    db.commit()

    # A reviewer opens the record (reserving it) but never submits a decision.
    claim_next_work_item(db, project.id, ScreeningStage.TITLE_ABSTRACT, r1.id)
    db.commit()

    csrf = client.post(
        "/api/v1/auth/login",
        json={"username": "admin3", "password": "secret-password"},
    ).json()["csrfToken"]
    response = client.get(
        f"/api/v1/projects/{project.id}/screening/title_abstract/conflicts",
        headers={"X-CSRF-Token": csrf},
    )

    assert response.status_code == 200
    assert response.json() == []
