from io import BytesIO

from openpyxl import load_workbook

from app.accounts.service import create_user
from app.audit.models import AuditEvent
from app.audit.service import project_dashboard, record_audit, reviewer_progress
from app.conflicts.service import record_final_decision
from app.extraction.models import ExtractionStatus, ExtractionWorkItem
from app.projects.models import Project, ProjectMembership, ReviewType, ScreeningStage
from app.publications.models import Publication
from app.quality.models import QualityStatus, QualityWorkItem
from app.reporting.service import build_excel
from app.screening.models import ScreeningWorkItem, WorkItemStatus


def test_audit_events_are_append_only_domain_records(db) -> None:
    admin = create_user(db, "admin", "Admin", "secret-password", is_admin=True)
    project = Project(
        name="Audit Review",
        review_type=ReviewType.SYSTEMATIC_REVIEW,
        random_seed="seed",
    )
    db.add(project)
    db.flush()

    first = record_audit(
        db,
        action="project.created",
        entity_type="project",
        entity_id=project.id,
        project_id=project.id,
        actor_id=admin.id,
        summary="Created project Audit Review",
    )
    second = record_audit(
        db,
        action="project.configuration_changed",
        entity_type="project",
        entity_id=project.id,
        project_id=project.id,
        actor_id=admin.id,
        summary="Changed review configuration",
        metadata={"field": "review_type"},
    )
    db.commit()

    events = db.query(AuditEvent).order_by(AuditEvent.created_at, AuditEvent.id).all()
    assert {event.id for event in events} == {first.id, second.id}
    assert events[1].event_metadata == {"field": "review_type"}


def test_dashboard_and_excel_include_audit_information(db) -> None:
    admin = create_user(db, "admin", "Admin", "secret-password", is_admin=True)
    project = Project(
        name="Dashboard Review",
        review_type=ReviewType.SYSTEMATIC_REVIEW,
        random_seed="seed",
    )
    db.add(project)
    db.flush()
    record_audit(
        db,
        action="project.created",
        entity_type="project",
        entity_id=project.id,
        project_id=project.id,
        actor_id=admin.id,
        summary="Created dashboard review",
    )
    db.commit()

    dashboard = project_dashboard(db, project.id)
    assert dashboard["stage"] == "draft"
    assert dashboard["failedJobs"] == 0
    assert dashboard["totalPapers"] == 0
    assert dashboard["papersAfterDuplicateReview"] == 0
    assert dashboard["papersAfterTitleAbstractScreening"] == 0
    assert dashboard["papersAfterFullTextScreening"] == 0

    workbook = load_workbook(BytesIO(build_excel(db, project.id)))
    audit_sheet = workbook["Audit history"]
    assert audit_sheet.max_row == 2
    assert audit_sheet.cell(row=2, column=3).value == "project.created"


def test_reviewer_progress_reports_assigned_and_completed_counts_per_stage(
    db,
) -> None:
    project = Project(
        name="Progress Review",
        review_type=ReviewType.SYSTEMATIC_REVIEW,
        random_seed="seed",
    )
    db.add(project)
    db.flush()
    reviewer1 = create_user(db, "reviewer1", "Reviewer One", "secret-password")
    reviewer2 = create_user(db, "reviewer2", "Reviewer Two", "secret-password")
    publications = [
        Publication(project_id=project.id, title=f"Paper {i}") for i in range(3)
    ]
    db.add_all(publications)
    db.flush()

    db.add_all(
        [
            ScreeningWorkItem(
                project_id=project.id,
                publication_id=publications[0].id,
                stage=ScreeningStage.TITLE_ABSTRACT,
                slot_number=1,
                assigned_reviewer_id=reviewer1.id,
                random_rank="a",
                status=WorkItemStatus.SUBMITTED,
            ),
            ScreeningWorkItem(
                project_id=project.id,
                publication_id=publications[1].id,
                stage=ScreeningStage.TITLE_ABSTRACT,
                slot_number=1,
                assigned_reviewer_id=reviewer1.id,
                random_rank="b",
                status=WorkItemStatus.AVAILABLE,
            ),
            ScreeningWorkItem(
                project_id=project.id,
                publication_id=publications[2].id,
                stage=ScreeningStage.TITLE_ABSTRACT,
                slot_number=1,
                assigned_reviewer_id=reviewer2.id,
                random_rank="c",
                status=WorkItemStatus.SUBMITTED,
            ),
        ]
    )
    db.add(
        ExtractionWorkItem(
            project_id=project.id,
            publication_id=publications[0].id,
            assigned_reviewer_id=reviewer1.id,
            random_rank="d",
            status=ExtractionStatus.COMPLETED,
        )
    )
    db.add(
        QualityWorkItem(
            project_id=project.id,
            publication_id=publications[0].id,
            assigned_reviewer_id=reviewer2.id,
            random_rank="e",
            status=QualityStatus.AVAILABLE,
        )
    )
    db.commit()

    stages = reviewer_progress(db, project.id)
    by_stage = {stage["stage"]: stage for stage in stages}
    assert set(by_stage) == {"title_abstract", "full_text", "extraction", "quality"}

    title_abstract = {
        r["reviewerId"]: r for r in by_stage["title_abstract"]["reviewers"]
    }
    assert title_abstract[reviewer1.id]["assigned"] == 2
    assert title_abstract[reviewer1.id]["completed"] == 1
    assert title_abstract[reviewer2.id]["assigned"] == 1
    assert title_abstract[reviewer2.id]["completed"] == 1

    assert by_stage["full_text"]["reviewers"] == []

    extraction = {r["reviewerId"]: r for r in by_stage["extraction"]["reviewers"]}
    assert extraction[reviewer1.id]["assigned"] == 1
    assert extraction[reviewer1.id]["completed"] == 1
    assert extraction[reviewer1.id]["reviewerName"] == "Reviewer One"

    quality = {r["reviewerId"]: r for r in by_stage["quality"]["reviewers"]}
    assert quality[reviewer2.id]["assigned"] == 1
    assert quality[reviewer2.id]["completed"] == 0


def test_reviewer_progress_route_is_restricted_to_project_managers(client, db) -> None:
    create_user(db, "admin", "Administrator", "secret-password", is_admin=True)
    member = create_user(db, "reviewer", "Reviewer", "secret-password")
    project = Project(
        name="Progress Review",
        review_type=ReviewType.SYSTEMATIC_REVIEW,
        random_seed="seed",
    )
    db.add(project)
    db.flush()
    db.add(ProjectMembership(project_id=project.id, user_id=member.id))
    db.commit()

    member_csrf = client.post(
        "/api/v1/auth/login",
        json={"username": "reviewer", "password": "secret-password"},
    ).json()["csrfToken"]
    denied = client.get(
        f"/api/v1/projects/{project.id}/reviewer-progress",
        headers={"X-CSRF-Token": member_csrf},
    )
    assert denied.status_code == 403

    admin_csrf = client.post(
        "/api/v1/auth/login",
        json={"username": "admin", "password": "secret-password"},
    ).json()["csrfToken"]
    allowed = client.get(
        f"/api/v1/projects/{project.id}/reviewer-progress",
        headers={"X-CSRF-Token": admin_csrf},
    )
    assert allowed.status_code == 200
    assert {stage["stage"] for stage in allowed.json()} == {
        "title_abstract",
        "full_text",
        "extraction",
        "quality",
    }


def test_dashboard_counts_papers_through_the_screening_pipeline(db) -> None:
    project = Project(
        name="Screening Review",
        review_type=ReviewType.SYSTEMATIC_REVIEW,
        random_seed="seed",
    )
    db.add(project)
    db.flush()
    publications = [
        Publication(project_id=project.id, title=f"Paper {i}") for i in range(4)
    ]
    db.add_all(publications)
    db.flush()
    publications[3].is_active = False  # merged away as a duplicate
    record_final_decision(
        db,
        publications[0].id,
        ScreeningStage.TITLE_ABSTRACT,
        "include",
        "agreement",
        None,
        None,
    )
    record_final_decision(
        db,
        publications[1].id,
        ScreeningStage.TITLE_ABSTRACT,
        "exclude",
        "agreement",
        None,
        None,
    )
    record_final_decision(
        db,
        publications[0].id,
        ScreeningStage.FULL_TEXT,
        "include",
        "agreement",
        None,
        None,
    )
    db.commit()

    dashboard = project_dashboard(db, project.id)
    assert dashboard["totalPapers"] == 4
    assert dashboard["papersAfterDuplicateReview"] == 3
    assert dashboard["papersAfterTitleAbstractScreening"] == 1
    assert dashboard["papersAfterFullTextScreening"] == 1
