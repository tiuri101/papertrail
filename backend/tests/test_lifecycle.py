import pytest

from app.accounts.service import create_user
from app.audit.models import AuditEvent
from app.conflicts.models import FinalDecision
from app.conflicts.service import record_final_decision
from app.extraction.models import ExtractionStatus, ExtractionWorkItem
from app.fulltext.models import PublicationDocument
from app.llm.models import (
    DocumentTextExtraction,
    ProcessingStatus,
    ProjectLlmSettings,
)
from app.projects.lifecycle import (
    evaluate_project_completion,
    move_project_back,
    project_integrity_issues,
    reopen_project,
)
from app.projects.models import Project, ProjectStage, ReviewType, ScreeningStage
from app.publications.models import Publication


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


def test_project_completes_and_can_be_reopened_without_deleting_work(db) -> None:
    admin, project, publication = create_included_project(db)
    work_item = ExtractionWorkItem(
        project_id=project.id,
        publication_id=publication.id,
        assigned_reviewer_id=admin.id,
        random_rank="rank",
        status=ExtractionStatus.COMPLETED,
    )
    db.add(work_item)
    db.flush()

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


def test_project_waits_for_enabled_validation_cohort_but_not_unusable_text(db) -> None:
    admin, project, publication = create_included_project(db)
    db.add(
        ExtractionWorkItem(
            project_id=project.id,
            publication_id=publication.id,
            assigned_reviewer_id=admin.id,
            random_rank="rank",
            status=ExtractionStatus.COMPLETED,
        )
    )
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
    db.add(
        ExtractionWorkItem(
            project_id=project.id,
            publication_id=included.id,
            assigned_reviewer_id=admin.id,
            random_rank="rank",
            status=ExtractionStatus.COMPLETED,
        )
    )
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
    work_item = ExtractionWorkItem(
        project_id=project.id,
        publication_id=publication.id,
        assigned_reviewer_id=admin.id,
        random_rank="rank",
        status=ExtractionStatus.COMPLETED,
    )
    db.add(work_item)
    db.commit()

    move_project_back(db, project, ProjectStage.TITLE_ABSTRACT, admin.id)
    db.commit()

    assert project.stage == ProjectStage.TITLE_ABSTRACT
    # Downstream extraction work and the full-text final decision are wiped.
    assert db.get(ExtractionWorkItem, work_item.id) is None
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


def test_integrity_check_detects_missing_downstream_work(db) -> None:
    _, project, publication = create_included_project(db)
    issues = project_integrity_issues(db, project)
    assert {(issue["code"], issue["entityId"]) for issue in issues} == {
        ("missing_extraction_item", publication.id)
    }
