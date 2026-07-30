from app.accounts.service import create_user
from app.audit.models import AuditEvent
from app.audit.service import project_dashboard, record_audit
from app.projects.models import Project, ReviewType
from app.reporting.service import build_excel
from io import BytesIO
from openpyxl import load_workbook


def test_audit_events_are_append_only_domain_records(db) -> None:
    admin = create_user(db, "admin", "Admin", "secret-password", is_admin=True)
    project = Project(name="Audit Review", review_type=ReviewType.SYSTEMATIC_REVIEW, random_seed="seed")
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
    project = Project(name="Dashboard Review", review_type=ReviewType.SYSTEMATIC_REVIEW, random_seed="seed")
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

    workbook = load_workbook(BytesIO(build_excel(db, project.id)))
    audit_sheet = workbook["Audit history"]
    assert audit_sheet.max_row == 2
    assert audit_sheet.cell(row=2, column=3).value == "project.created"
