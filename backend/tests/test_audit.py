from io import BytesIO

from openpyxl import load_workbook

from app.accounts.service import create_user
from app.audit.models import AuditEvent
from app.audit.service import project_dashboard, record_audit
from app.conflicts.service import record_final_decision
from app.projects.models import Project, ReviewType, ScreeningStage
from app.publications.models import Publication
from app.reporting.service import build_excel


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
