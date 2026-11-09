from __future__ import annotations

from sqlalchemy import select

from app.accounts.service import create_user
from app.conflicts.service import (
    record_final_decision,
    transition_if_screening_complete,
)
from app.core.config import Settings
from app.deduplication.service import (
    detect_duplicates,
    transition_if_duplicate_review_complete,
)
from app.extraction.models import ExtractionStatus, ExtractionWorkItem, FinalExtraction
from app.forms.models import FormKind
from app.forms.service import create_form
from app.jobs.models import BackgroundJob, JobStatus
from app.jobs.worker import execute_next_job
from app.notifications.mailer import send_smtp_email
from app.notifications.models import EmailDeliveryStatus, EmailNotification
from app.notifications.templates import render_email
from app.projects.lifecycle import evaluate_project_completion
from app.projects.models import (
    ProjectMembership,
    ProjectStage,
    ReviewType,
    ScreeningStage,
)
from app.projects.service import create_project
from app.publications.models import Publication


def email_settings(db=None) -> Settings:
    return Settings(
        _env_file=None,
        email_enabled=True,
        public_base_url="https://papertrail.example.org/",
        smtp_host="smtp.example.org",
        smtp_from_address="papertrail@example.org",
    )


def login(client, username: str, password: str) -> str:
    response = client.post(
        "/api/v1/auth/login", json={"username": username, "password": password}
    )
    assert response.status_code == 200
    return response.json()["csrfToken"]


def test_registration_queues_deduplicated_welcome_email(
    client, db, monkeypatch
) -> None:
    monkeypatch.setattr(
        "app.notifications.service.effective_instance_settings", email_settings
    )
    create_user(db, "admin", "Administrator", "secret-password", is_admin=True)
    db.commit()
    csrf = login(client, "admin", "secret-password")

    response = client.post(
        "/api/v1/users",
        json={
            "username": "reviewer",
            "displayName": "Review User",
            "email": "Reviewer@Example.org",
            "password": "reviewer-password",
        },
        headers={"X-CSRF-Token": csrf},
    )

    assert response.status_code == 201
    assert response.json()["email"] == "reviewer@example.org"
    notification = db.scalar(select(EmailNotification))
    assert notification is not None
    assert notification.template == "account_created"
    assert notification.recipient_email == "reviewer@example.org"
    assert "password" not in notification.context
    job = db.scalar(select(BackgroundJob).where(BackgroundJob.job_type == "send_email"))
    assert job is not None
    assert job.payload == {"notification_id": notification.id}


def test_smtp_transport_uses_starttls_and_optional_authentication(monkeypatch) -> None:
    events: list[object] = []

    class FakeSmtp:
        def __init__(self, host: str, port: int, *, timeout: int) -> None:
            events.append((host, port, timeout))

        def __enter__(self):
            return self

        def __exit__(self, *_args) -> None:
            return None

        def starttls(self) -> None:
            events.append("starttls")

        def login(self, username: str, password: str) -> None:
            events.append((username, password))

        def send_message(self, message) -> None:
            events.append((message["To"], message["Subject"]))

    monkeypatch.setattr("app.notifications.mailer.smtplib.SMTP", FakeSmtp)
    settings = email_settings().model_copy(
        update={"smtp_username": "smtp-user", "smtp_password": "smtp-secret"}
    )
    rendered = render_email(
        "account_created",
        {
            "recipient_name": "Reviewer",
            "username": "reviewer",
            "login_url": "https://papertrail.example.org/login",
        },
    )

    send_smtp_email(settings, recipient="reviewer@example.org", rendered=rendered)

    assert events == [
        ("smtp.example.org", 587, 30),
        "starttls",
        ("smtp-user", "smtp-secret"),
        ("reviewer@example.org", "Your Papertrail account is ready"),
    ]


def test_html_email_uses_papertrail_design_and_escapes_dynamic_content() -> None:
    rendered = render_email(
        "project_membership_added",
        {
            "recipient_name": "Reviewer <script>alert(1)</script>",
            "project_name": "Evidence & Cities",
            "project_url": "https://papertrail.example.org/projects/project-1?tab=work",
            "home_url": "https://papertrail.example.org",
        },
    )

    assert "background:#f4f6fb" in rendered.html_body
    assert 'xmlns:v="urn:schemas-microsoft-com:vml"' in rendered.html_body
    assert "<!--[if mso]>" in rendered.html_body
    assert "<o:PixelsPerInch>96</o:PixelsPerInch>" in rendered.html_body
    assert '<table role="presentation" width="600"' in rendered.html_body
    assert "mso-padding-alt:32px 38px 34px" in rendered.html_body
    assert rendered.html_body.count("<v:roundrect") == 1
    assert rendered.html_body.count("</v:roundrect>") == 1
    assert "<v:textbox" not in rendered.html_body
    assert "mso-fit-shape-to-text" not in rendered.html_body
    assert 'arcsize="20%"' in rendered.html_body
    assert '<td height="4" bgcolor="#5369d8"' in rendered.html_body
    assert '<div style="padding:' not in rendered.html_body
    assert '<p style="margin:' not in rendered.html_body
    assert "Papertrail notification" in rendered.html_body
    assert "Reviewer &lt;script&gt;alert(1)&lt;/script&gt;" in rendered.html_body
    assert "Evidence &amp; Cities" in rendered.html_body
    assert "<script>alert(1)</script>" not in rendered.html_body
    assert "projects/project-1?tab=work" in rendered.html_body


def test_llm_completion_email_has_compact_status_summary() -> None:
    rendered = render_email(
        "llm_stage_completed",
        {
            "recipient_name": "Owner",
            "stage_label": "title and abstract screening",
            "project_name": "Evidence Review",
            "completed_count": 18,
            "failed_count": 2,
            "other_count": 1,
            "project_url": "https://papertrail.example.org/projects/project-1/admin",
        },
    )

    assert "Completed" in rendered.html_body
    assert "#147a59" in rendered.html_body
    assert "Failed" in rendered.html_body
    assert "#bf3f46" in rendered.html_body
    assert "Other" in rendered.html_body
    assert "#9d6712" in rendered.html_body


def test_project_creation_emails_active_administrators(db, monkeypatch) -> None:
    monkeypatch.setattr(
        "app.notifications.service.effective_instance_settings", email_settings
    )
    creator = create_user(
        db,
        "owner",
        "Project Owner",
        "secret-password",
        email="owner@example.org",
    )
    first_admin = create_user(
        db,
        "admin-one",
        "First Administrator",
        "secret-password",
        is_admin=True,
        email="admin-one@example.org",
    )
    second_admin = create_user(
        db,
        "admin-two",
        "Second Administrator",
        "secret-password",
        is_admin=True,
        email="admin-two@example.org",
    )
    inactive_admin = create_user(
        db,
        "inactive-admin",
        "Inactive Administrator",
        "secret-password",
        is_admin=True,
        email="inactive@example.org",
    )
    inactive_admin.is_active = False
    create_user(
        db,
        "admin-without-email",
        "Administrator Without Email",
        "secret-password",
        is_admin=True,
    )

    project = create_project(
        db, "Evidence Review", None, ReviewType.SYSTEMATIC_REVIEW, creator
    )

    notifications = list(
        db.scalars(
            select(EmailNotification)
            .where(EmailNotification.template == "project_created")
            .order_by(EmailNotification.recipient_email)
        )
    )
    assert [item.recipient_user_id for item in notifications] == [
        first_admin.id,
        second_admin.id,
    ]
    assert [item.recipient_email for item in notifications] == [
        "admin-one@example.org",
        "admin-two@example.org",
    ]
    assert all(item.project_id == project.id for item in notifications)
    assert all(
        item.context["project_name"] == "Evidence Review" for item in notifications
    )
    assert all(
        item.context["creator_name"] == "Project Owner" for item in notifications
    )
    assert all(
        item.context["project_url"]
        == f"https://papertrail.example.org/projects/{project.id}"
        for item in notifications
    )
    assert all(
        render_email(item.template, item.context).subject
        == 'New project created: "Evidence Review"'
        for item in notifications
    )
    jobs = list(
        db.scalars(select(BackgroundJob).where(BackgroundJob.job_type == "send_email"))
    )
    assert len(jobs) == 2


def test_project_creation_does_not_queue_email_when_email_is_disabled(
    db, monkeypatch
) -> None:
    disabled_settings = email_settings().model_copy(update={"email_enabled": False})
    monkeypatch.setattr(
        "app.notifications.service.effective_instance_settings",
        lambda db: disabled_settings,
    )
    creator = create_user(db, "owner", "Project Owner", "secret-password")
    create_user(
        db,
        "admin",
        "Administrator",
        "secret-password",
        is_admin=True,
        email="admin@example.org",
    )

    create_project(db, "Evidence Review", None, ReviewType.SYSTEMATIC_REVIEW, creator)

    assert list(db.scalars(select(EmailNotification))) == []
    assert (
        list(
            db.scalars(
                select(BackgroundJob).where(BackgroundJob.job_type == "send_email")
            )
        )
        == []
    )


def test_project_completion_email_is_sent_only_to_project_owner(
    db, monkeypatch
) -> None:
    monkeypatch.setattr(
        "app.notifications.service.effective_instance_settings", email_settings
    )
    owner = create_user(
        db,
        "owner",
        "Project Owner",
        "secret-password",
        email="owner@example.org",
    )
    reviewer = create_user(
        db,
        "reviewer",
        "Reviewer",
        "secret-password",
        email="reviewer@example.org",
    )
    project = create_project(
        db, "Evidence Review", None, ReviewType.SYSTEMATIC_REVIEW, owner
    )
    db.add(
        ProjectMembership(
            project_id=project.id,
            user_id=reviewer.id,
            can_extract=True,
        )
    )
    project.stage = ProjectStage.EXTRACTION
    publication = Publication(project_id=project.id, title="Included study")
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
    db.add(
        ExtractionWorkItem(
            project_id=project.id,
            publication_id=publication.id,
            assigned_reviewer_id=reviewer.id,
            random_rank="rank",
            status=ExtractionStatus.COMPLETED,
        )
    )
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

    assert evaluate_project_completion(db, project) is True
    assert evaluate_project_completion(db, project) is True

    notifications = list(db.scalars(select(EmailNotification)))
    assert len(notifications) == 1
    notification = notifications[0]
    assert notification.template == "project_completed"
    assert notification.recipient_user_id == owner.id
    assert notification.recipient_email == "owner@example.org"
    assert notification.context["project_name"] == "Evidence Review"
    assert (
        "Completed"
        in render_email(notification.template, notification.context).html_body
    )
    jobs = list(
        db.scalars(select(BackgroundJob).where(BackgroundJob.job_type == "send_email"))
    )
    assert len(jobs) == 1


def test_stage_completion_email_is_sent_only_to_project_owner(db, monkeypatch) -> None:
    monkeypatch.setattr(
        "app.notifications.service.effective_instance_settings", email_settings
    )
    owner = create_user(
        db,
        "owner",
        "Project Owner",
        "secret-password",
        email="owner@example.org",
    )
    reviewer = create_user(
        db,
        "reviewer",
        "Reviewer",
        "secret-password",
        email="reviewer@example.org",
    )
    project = create_project(
        db, "Evidence Review", None, ReviewType.SYSTEMATIC_REVIEW, owner
    )
    db.add(ProjectMembership(project_id=project.id, user_id=reviewer.id))
    project.stage = ProjectStage.DUPLICATE_REVIEW
    db.flush()
    # No publications means duplicate detection finds nothing to resolve, so
    # the stage completes immediately.
    detect_duplicates(db, project.id)
    db.commit()
    # The project-created email is queued too; ignore it and look only at the
    # stage-completion notification queued once the stage advances.
    db.query(EmailNotification).delete()
    db.commit()

    assert transition_if_duplicate_review_complete(db, project) is True
    assert project.stage == ProjectStage.TITLE_ABSTRACT

    notifications = list(db.scalars(select(EmailNotification)))
    assert len(notifications) == 1
    notification = notifications[0]
    assert notification.template == "project_stage_completed"
    assert notification.recipient_user_id == owner.id
    assert notification.recipient_email == "owner@example.org"
    assert notification.context["project_name"] == "Evidence Review"
    assert notification.context["stage_label"] == "Resolve Duplicates"
    rendered = render_email(notification.template, notification.context)
    assert "Resolve Duplicates" in rendered.html_body
    jobs = list(
        db.scalars(select(BackgroundJob).where(BackgroundJob.job_type == "send_email"))
    )
    assert len(jobs) == 1


def test_screening_stage_completion_advances_and_notifies_owner(
    db, monkeypatch
) -> None:
    monkeypatch.setattr(
        "app.notifications.service.effective_instance_settings", email_settings
    )
    owner = create_user(
        db,
        "owner",
        "Project Owner",
        "secret-password",
        email="owner@example.org",
    )
    project = create_project(
        db, "Evidence Review", None, ReviewType.SYSTEMATIC_REVIEW, owner
    )
    project.stage = ProjectStage.TITLE_ABSTRACT
    db.flush()
    db.query(EmailNotification).delete()
    db.commit()

    assert (
        transition_if_screening_complete(db, project, ScreeningStage.TITLE_ABSTRACT)
        is True
    )
    assert project.stage == ProjectStage.FULL_TEXT

    notification = db.scalar(
        select(EmailNotification).where(
            EmailNotification.template == "project_stage_completed"
        )
    )
    assert notification is not None
    assert notification.context["stage_label"] == "Title/Abstract Screening"


def test_membership_add_and_remove_send_email_but_permission_change_does_not(
    client, db, monkeypatch
) -> None:
    monkeypatch.setattr(
        "app.notifications.service.effective_instance_settings", email_settings
    )
    create_user(db, "admin", "Administrator", "secret-password", is_admin=True)
    reviewer = create_user(
        db,
        "reviewer",
        "Reviewer",
        "reviewer-password",
        email="reviewer@example.org",
    )
    db.commit()
    csrf = login(client, "admin", "secret-password")
    project_id = client.post(
        "/api/v1/projects",
        json={"name": "Urban Review", "reviewType": "systematic_review"},
        headers={"X-CSRF-Token": csrf},
    ).json()["id"]

    membership = client.post(
        f"/api/v1/projects/{project_id}/members",
        json={
            "userId": reviewer.id,
            "canTitleAbstractScreen": True,
            "canFullTextScreen": False,
            "canExtract": False,
            "canAssessQuality": False,
            "canAdjudicate": False,
        },
        headers={"X-CSRF-Token": csrf},
    )
    assert membership.status_code == 201
    member_id = membership.json()["id"]

    updated = client.patch(
        f"/api/v1/projects/{project_id}/members/{member_id}",
        json={
            "canTitleAbstractScreen": True,
            "canFullTextScreen": True,
            "canExtract": False,
            "canAssessQuality": False,
            "canAdjudicate": False,
        },
        headers={"X-CSRF-Token": csrf},
    )
    assert updated.status_code == 200
    assert db.scalar(
        select(EmailNotification).where(
            EmailNotification.template == "project_membership_added"
        )
    )
    assert len(list(db.scalars(select(EmailNotification)))) == 1

    removed = client.delete(
        f"/api/v1/projects/{project_id}/members/{member_id}",
        headers={"X-CSRF-Token": csrf},
    )
    assert removed.status_code == 204
    templates = list(db.scalars(select(EmailNotification.template)))
    assert templates == ["project_membership_added", "project_membership_removed"]


def test_email_job_uses_worker_and_records_success(
    client, db, session_factory, monkeypatch
) -> None:
    monkeypatch.setattr(
        "app.notifications.service.effective_instance_settings", email_settings
    )
    sent: list[tuple[str, str]] = []

    def fake_send(_settings, *, recipient, rendered) -> None:
        sent.append((recipient, rendered.subject))

    monkeypatch.setattr("app.notifications.service.send_smtp_email", fake_send)
    create_user(db, "admin", "Administrator", "secret-password", is_admin=True)
    db.commit()
    csrf = login(client, "admin", "secret-password")
    client.post(
        "/api/v1/users",
        json={
            "username": "reviewer",
            "displayName": "Reviewer",
            "email": "reviewer@example.org",
            "password": "reviewer-password",
        },
        headers={"X-CSRF-Token": csrf},
    )

    assert execute_next_job(session_factory, "test-worker") is True
    db.expire_all()
    notification = db.scalar(select(EmailNotification))
    assert notification is not None
    assert notification.status == EmailDeliveryStatus.SENT
    assert notification.sent_at is not None
    assert sent == [("reviewer@example.org", "Your Papertrail account is ready")]


def test_email_job_retries_and_records_terminal_failure(
    client, db, session_factory, monkeypatch
) -> None:
    monkeypatch.setattr(
        "app.notifications.service.effective_instance_settings", email_settings
    )

    def fail_send(*_args, **_kwargs) -> None:
        raise TimeoutError("SMTP timed out")

    monkeypatch.setattr("app.notifications.service.send_smtp_email", fail_send)
    create_user(db, "admin", "Administrator", "secret-password", is_admin=True)
    db.commit()
    csrf = login(client, "admin", "secret-password")
    client.post(
        "/api/v1/users",
        json={
            "username": "reviewer",
            "displayName": "Reviewer",
            "email": "reviewer@example.org",
            "password": "reviewer-password",
        },
        headers={"X-CSRF-Token": csrf},
    )

    for _ in range(5):
        assert execute_next_job(session_factory, "test-worker") is True

    db.expire_all()
    notification = db.scalar(select(EmailNotification))
    job = db.scalar(select(BackgroundJob).where(BackgroundJob.job_type == "send_email"))
    assert notification is not None
    assert notification.status == EmailDeliveryStatus.FAILED
    assert notification.attempts == 5
    assert notification.error_message == "SMTP timed out"
    assert job is not None
    assert job.status == JobStatus.FAILED


def test_project_owner_users_returns_only_owners(db) -> None:
    """A project has exactly one owner (uq_project_single_owner), and owner
    notifications must reach that member and no other."""
    from app.notifications.service import _project_owner_users

    owner = create_user(db, "owner", "Project Owner", "secret-password")
    reviewer = create_user(db, "reviewer", "Reviewer", "secret-password")
    other_project_owner = create_user(db, "other", "Other Owner", "secret-password")
    project = create_project(
        db, "Evidence Review", None, ReviewType.SYSTEMATIC_REVIEW, owner
    )
    create_project(
        db, "Unrelated Review", None, ReviewType.SYSTEMATIC_REVIEW, other_project_owner
    )
    db.add(
        ProjectMembership(project_id=project.id, user_id=reviewer.id, can_extract=True)
    )
    db.flush()

    owners = _project_owner_users(db, project.id)

    assert {user.id for user in owners} == {owner.id}


def _capture_sent_email(monkeypatch) -> list[tuple[str, str, str]]:
    monkeypatch.setattr(
        "app.notifications.service.effective_instance_settings", email_settings
    )
    sent: list[tuple[str, str, str]] = []

    def fake_send(_settings, *, recipient, rendered) -> None:
        sent.append((recipient, rendered.subject, rendered.text_body))

    monkeypatch.setattr("app.notifications.service.send_smtp_email", fake_send)
    return sent


def _queue_import(db, tmp_path, content: bytes) -> tuple[str, str]:
    from app.imports.models import ImportBatch, ImportStatus
    from app.jobs.service import enqueue_job
    from app.projects.models import Project

    user = create_user(
        db, "importer", "Importer", "secret-password", email="importer@example.org"
    )
    project = Project(
        name="Review", review_type=ReviewType.SYSTEMATIC_REVIEW, random_seed="seed"
    )
    db.add(project)
    db.flush()
    stored_path = tmp_path / "records.csv"
    stored_path.write_bytes(content)
    batch = ImportBatch(
        project_id=project.id,
        original_filename="records.csv",
        stored_path=str(stored_path),
        file_type="csv",
        status=ImportStatus.PENDING,
        created_by_id=user.id,
    )
    db.add(batch)
    db.flush()
    enqueue_job(
        db,
        "parse_import",
        {"import_batch_id": batch.id},
        project_id=project.id,
        created_by_id=user.id,
        max_attempts=2,
    )
    db.commit()
    return project.id, batch.id


def test_importer_is_emailed_when_an_import_finishes(
    db, session_factory, tmp_path, monkeypatch
) -> None:
    sent = _capture_sent_email(monkeypatch)
    project_id, _batch_id = _queue_import(
        db, tmp_path, b"Title,Authors\nPaper one,Doe\n,Roe\n"
    )

    while execute_next_job(session_factory, "test-worker"):
        pass

    assert len(sent) == 1
    recipient, subject, body = sent[0]
    assert recipient == "importer@example.org"
    assert "records.csv" in subject
    assert "2 record(s)" in body and "1 of them" in body
    assert f"/projects/{project_id}/imports" in body


def test_importer_is_emailed_once_when_an_import_fails_for_good(
    db, session_factory, tmp_path, monkeypatch
) -> None:
    sent = _capture_sent_email(monkeypatch)

    def broken_parse(_name, _data):
        raise ValueError("unreadable file")

    monkeypatch.setattr("app.imports.service.parse_file", broken_parse)
    project_id, _batch_id = _queue_import(db, tmp_path, b"Title\nPaper\n")

    while execute_next_job(session_factory, "test-worker"):
        pass

    assert len(sent) == 1
    recipient, subject, body = sent[0]
    assert recipient == "importer@example.org"
    assert "records.csv" in subject and "failed" in subject
    assert "unreadable file" in body
    assert f"/projects/{project_id}/imports" in body


def test_owners_are_emailed_when_duplicate_detection_fails_for_good(
    db, session_factory, monkeypatch
) -> None:
    from app.jobs.service import enqueue_job

    sent = _capture_sent_email(monkeypatch)
    owner = create_user(
        db, "owner", "Owner", "owner-password", email="owner@example.org"
    )
    member = create_user(
        db, "member", "Member", "member-password", email="member@example.org"
    )
    project = create_project(
        db,
        "Dedup Review",
        None,
        ReviewType.SYSTEMATIC_REVIEW,
        owner,
    )
    db.add(ProjectMembership(project_id=project.id, user_id=member.id))
    enqueue_job(
        db,
        "detect_duplicates",
        {"project_id": project.id},
        project_id=project.id,
        created_by_id=owner.id,
        max_attempts=2,
    )
    db.commit()
    sent.clear()

    def broken_detection(*_args, **_kwargs):
        raise RuntimeError("matcher crashed")

    monkeypatch.setattr(
        "app.deduplication.jobs.detect_duplicates", broken_detection
    )
    while execute_next_job(session_factory, "test-worker"):
        pass

    assert len(sent) == 1
    recipient, subject, body = sent[0]
    assert recipient == "owner@example.org"
    assert "Dedup Review" in subject
    assert "matcher crashed" in body
    assert f"/projects/{project.id}/duplicates" in body


def test_failed_import_is_still_marked_failed_when_its_email_cannot_be_queued(
    db, session_factory, tmp_path, monkeypatch
) -> None:
    from app.imports.models import ImportBatch, ImportStatus

    _capture_sent_email(monkeypatch)

    def broken_parse(_name, _data):
        raise ValueError("unreadable file")

    def broken_email(*_args, **_kwargs):
        raise RuntimeError("template exploded")

    monkeypatch.setattr("app.imports.service.parse_file", broken_parse)
    monkeypatch.setattr("app.imports.service.queue_import_failed_email", broken_email)
    _project_id, batch_id = _queue_import(db, tmp_path, b"Title\nPaper\n")

    while execute_next_job(session_factory, "test-worker"):
        pass

    db.expire_all()
    batch = db.get(ImportBatch, batch_id)
    assert batch is not None
    assert batch.status == ImportStatus.FAILED
    assert batch.error_message == "unreadable file"
