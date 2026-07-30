from app.accounts.service import create_user
from app.audit.models import AuditEvent
from app.conflicts.service import record_final_decision
from app.extraction.models import ExtractionStatus, ExtractionWorkItem
from app.projects.lifecycle import (
    evaluate_project_completion,
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


def test_integrity_check_detects_missing_downstream_work(db) -> None:
    _, project, publication = create_included_project(db)
    issues = project_integrity_issues(db, project)
    assert {(issue["code"], issue["entityId"]) for issue in issues} == {
        ("missing_extraction_item", publication.id)
    }
