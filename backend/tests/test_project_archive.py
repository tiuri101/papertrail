from __future__ import annotations

from sqlalchemy import select

from app.accounts.service import create_user
from app.audit.models import AuditEvent
from app.core.config import Settings
from app.notifications.models import EmailNotification
from app.notifications.templates import render_email
from app.projects.models import Project


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


def _project_with_reviewer(client, db) -> tuple[str, str, str]:
    """An admin-owned project with one reviewer; returns (csrf, project, reviewer)."""
    create_user(
        db,
        "admin",
        "Administrator",
        "secret-password",
        email="admin@example.org",
        is_admin=True,
    )
    reviewer = create_user(
        db, "reviewer", "Reviewer", "reviewer-password", email="reviewer@example.org"
    )
    db.commit()
    csrf = login(client, "admin", "secret-password")
    project_id = client.post(
        "/api/v1/projects",
        json={"name": "Urban Review", "reviewType": "systematic_review"},
        headers={"X-CSRF-Token": csrf},
    ).json()["id"]
    added = client.post(
        f"/api/v1/projects/{project_id}/members",
        json={"userId": reviewer.id, "canTitleAbstractScreen": True},
        headers={"X-CSRF-Token": csrf},
    )
    assert added.status_code == 201
    return csrf, project_id, reviewer.id


def test_archived_projects_leave_the_overview_but_stay_listed_and_open(
    client, db
) -> None:
    csrf, project_id, _ = _project_with_reviewer(client, db)
    client.post(
        "/api/v1/projects",
        json={"name": "Active Review", "reviewType": "scoping_review"},
        headers={"X-CSRF-Token": csrf},
    )

    archived = client.post(
        f"/api/v1/projects/{project_id}/archive", headers={"X-CSRF-Token": csrf}
    )
    assert archived.status_code == 200
    assert archived.json()["archivedAt"] is not None

    active = client.get("/api/v1/projects").json()
    assert [project["name"] for project in active] == ["Active Review"]
    assert active[0]["archivedAt"] is None
    archive = client.get("/api/v1/projects", params={"archived": "true"}).json()
    assert [project["name"] for project in archive] == ["Urban Review"]
    assert archive[0]["archivedAt"] is not None

    detail = client.get(f"/api/v1/projects/{project_id}")
    assert detail.status_code == 200
    assert detail.json()["archivedAt"] is not None

    restored = client.post(
        f"/api/v1/projects/{project_id}/unarchive", headers={"X-CSRF-Token": csrf}
    )
    assert restored.status_code == 200
    assert restored.json()["archivedAt"] is None
    names = sorted(p["name"] for p in client.get("/api/v1/projects").json())
    assert names == ["Active Review", "Urban Review"]
    assert client.get("/api/v1/projects", params={"archived": "true"}).json() == []

    actions = list(
        db.scalars(
            select(AuditEvent.action)
            .where(AuditEvent.project_id == project_id)
            .where(AuditEvent.action.like("project.%archived"))
            .order_by(AuditEvent.created_at)
        )
    )
    assert actions == ["project.archived", "project.unarchived"]


def test_reviewer_sees_archived_membership_but_cannot_archive(client, db) -> None:
    csrf, project_id, _ = _project_with_reviewer(client, db)
    client.post(
        f"/api/v1/projects/{project_id}/archive", headers={"X-CSRF-Token": csrf}
    )
    client.post("/api/v1/auth/logout", headers={"X-CSRF-Token": csrf})

    reviewer_csrf = login(client, "reviewer", "reviewer-password")
    assert client.get("/api/v1/projects").json() == []
    archive = client.get("/api/v1/projects", params={"archived": "true"}).json()
    assert [project["id"] for project in archive] == [project_id]

    refused = client.post(
        f"/api/v1/projects/{project_id}/unarchive",
        headers={"X-CSRF-Token": reviewer_csrf},
    )
    assert refused.status_code == 403
    project = db.get(Project, project_id)
    assert project is not None
    db.refresh(project)
    assert project.archived_at is not None


def test_archiving_emails_every_project_member_once(client, db, monkeypatch) -> None:
    monkeypatch.setattr(
        "app.notifications.service.effective_instance_settings", email_settings
    )
    csrf, project_id, _ = _project_with_reviewer(client, db)

    for _attempt in range(2):
        response = client.post(
            f"/api/v1/projects/{project_id}/archive", headers={"X-CSRF-Token": csrf}
        )
        assert response.status_code == 200

    archived_emails = list(
        db.scalars(
            select(EmailNotification).where(
                EmailNotification.template == "project_archived"
            )
        )
    )
    assert sorted(email.recipient_email for email in archived_emails) == [
        "admin@example.org",
        "reviewer@example.org",
    ]
    assert archived_emails[0].context["actor_name"] == "Administrator"

    # Restoring is silent; archiving again is a new cycle and notifies again.
    client.post(
        f"/api/v1/projects/{project_id}/unarchive", headers={"X-CSRF-Token": csrf}
    )
    client.post(
        f"/api/v1/projects/{project_id}/archive", headers={"X-CSRF-Token": csrf}
    )
    templates = list(db.scalars(select(EmailNotification.template)))
    assert templates.count("project_archived") == 4


def test_project_archived_email_names_project_and_actor() -> None:
    rendered = render_email(
        "project_archived",
        {
            "recipient_name": "Reviewer",
            "project_name": "Urban <Review>",
            "actor_name": "Administrator",
            "project_url": "https://papertrail.example.org/projects/1",
        },
    )
    assert rendered.subject == 'Project "Urban <Review>" was archived'
    assert "Administrator archived" in rendered.text_body
    assert "Urban &lt;Review&gt;" in rendered.html_body
