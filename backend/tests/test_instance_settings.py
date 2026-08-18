from __future__ import annotations

from sqlalchemy import select

from app.accounts.service import create_user
from app.audit.models import AuditEvent
from app.instance_settings.service import effective_instance_settings

DEFAULT_PAYLOAD = {
    "emailEnabled": True,
    "publicBaseUrl": "https://papertrail.example.org",
    "smtpHost": "smtp.example.org",
    "smtpPort": 2525,
    "smtpUsername": "notifications",
    "smtpPassword": "hunter2",
    "smtpFromAddress": "Papertrail <notifications@example.org>",
    "smtpStarttls": True,
    "smtpUseSsl": False,
    "smtpTimeoutSeconds": 45,
    "workerThreads": 8,
    "jobPollIntervalSeconds": 2.5,
    "jobLeaseSeconds": 600,
    "browserRetrievalLeaseSeconds": 900,
    "maxPdfSizeMb": 120,
    "passwordResetTtlMinutes": 90,
    "passwordResetMaxAttempts": 3,
}


def login(client, username: str, password: str) -> str:
    response = client.post(
        "/api/v1/auth/login", json={"username": username, "password": password}
    )
    assert response.status_code == 200
    return response.json()["csrfToken"]


def test_anonymous_and_non_admin_cannot_access_instance_settings(client, db) -> None:
    create_user(db, "admin", "Administrator", "secret-password", is_admin=True)
    create_user(db, "reviewer", "Reviewer", "reviewer-password")
    db.commit()

    anonymous = client.get("/api/v1/instance-settings")
    assert anonymous.status_code == 403

    reviewer_csrf = login(client, "reviewer", "reviewer-password")
    forbidden = client.get("/api/v1/instance-settings")
    assert forbidden.status_code == 403

    forbidden_patch = client.patch(
        "/api/v1/instance-settings",
        json=DEFAULT_PAYLOAD,
        headers={"X-CSRF-Token": reviewer_csrf},
    )
    assert forbidden_patch.status_code == 403


def test_administrator_can_read_and_update_instance_settings(client, db) -> None:
    admin = create_user(
        db, "admin", "Administrator", "secret-password", is_admin=True
    )
    db.commit()
    csrf = login(client, "admin", "secret-password")

    defaults = client.get("/api/v1/instance-settings")
    assert defaults.status_code == 200
    assert defaults.json()["emailEnabled"] is False
    assert defaults.json()["smtpPasswordSet"] is False

    updated = client.patch(
        "/api/v1/instance-settings",
        json=DEFAULT_PAYLOAD,
        headers={"X-CSRF-Token": csrf},
    )
    assert updated.status_code == 200
    body = updated.json()
    assert body["emailEnabled"] is True
    assert body["publicBaseUrl"] == "https://papertrail.example.org"
    assert body["smtpHost"] == "smtp.example.org"
    assert body["smtpPasswordSet"] is True
    assert "smtpPassword" not in body
    assert body["workerThreads"] == 8
    assert body["jobPollIntervalSeconds"] == 2.5
    assert body["maxPdfSizeMb"] == 120
    assert body["passwordResetTtlMinutes"] == 90
    assert body["passwordResetMaxAttempts"] == 3

    refetched = client.get("/api/v1/instance-settings")
    assert refetched.status_code == 200
    assert refetched.json() == body

    effective = effective_instance_settings(db)
    assert effective.email_enabled is True
    assert effective.max_pdf_size_mb == 120
    assert effective.password_reset_ttl_minutes == 90
    assert effective.worker_threads == 8

    event = db.scalar(
        select(AuditEvent).where(AuditEvent.action == "instance_settings.updated")
    )
    assert event is not None
    assert event.actor_id == admin.id
    assert event.event_metadata["changes"]["emailEnabled"] == {
        "from": False,
        "to": True,
    }


def test_blank_smtp_password_keeps_previous_value(client, db) -> None:
    create_user(db, "admin", "Administrator", "secret-password", is_admin=True)
    db.commit()
    csrf = login(client, "admin", "secret-password")

    client.patch(
        "/api/v1/instance-settings",
        json=DEFAULT_PAYLOAD,
        headers={"X-CSRF-Token": csrf},
    )

    unchanged_password_payload = dict(DEFAULT_PAYLOAD, smtpPort=2626, smtpPassword=None)
    response = client.patch(
        "/api/v1/instance-settings",
        json=unchanged_password_payload,
        headers={"X-CSRF-Token": csrf},
    )
    assert response.status_code == 200
    assert response.json()["smtpPort"] == 2626
    assert response.json()["smtpPasswordSet"] is True

    effective = effective_instance_settings(db)
    assert effective.smtp_password == "hunter2"


def test_email_enabled_requires_host_and_from_address(client, db) -> None:
    create_user(db, "admin", "Administrator", "secret-password", is_admin=True)
    db.commit()
    csrf = login(client, "admin", "secret-password")

    invalid_payload = dict(DEFAULT_PAYLOAD, smtpHost=None)
    response = client.patch(
        "/api/v1/instance-settings",
        json=invalid_payload,
        headers={"X-CSRF-Token": csrf},
    )
    assert response.status_code == 422


def test_starttls_and_ssl_are_mutually_exclusive(client, db) -> None:
    create_user(db, "admin", "Administrator", "secret-password", is_admin=True)
    db.commit()
    csrf = login(client, "admin", "secret-password")

    invalid_payload = dict(DEFAULT_PAYLOAD, smtpUseSsl=True)
    response = client.patch(
        "/api/v1/instance-settings",
        json=invalid_payload,
        headers={"X-CSRF-Token": csrf},
    )
    assert response.status_code == 422


def test_administrator_can_send_test_email(client, db, monkeypatch) -> None:
    create_user(
        db,
        "admin",
        "Administrator",
        "secret-password",
        is_admin=True,
        email="admin@example.org",
    )
    db.commit()
    csrf = login(client, "admin", "secret-password")

    client.patch(
        "/api/v1/instance-settings",
        json=DEFAULT_PAYLOAD,
        headers={"X-CSRF-Token": csrf},
    )

    sent: dict[str, object] = {}

    def fake_send(settings, *, recipient, rendered):
        sent["recipient"] = recipient
        sent["subject"] = rendered.subject

    monkeypatch.setattr("app.instance_settings.routes.send_smtp_email", fake_send)

    response = client.post(
        "/api/v1/instance-settings/test-email",
        headers={"X-CSRF-Token": csrf},
    )
    assert response.status_code == 200
    assert response.json() == {"sent": True, "error": None}
    assert sent["recipient"] == "admin@example.org"


def test_test_email_reports_failure_without_raising(client, db, monkeypatch) -> None:
    create_user(
        db,
        "admin",
        "Administrator",
        "secret-password",
        is_admin=True,
        email="admin@example.org",
    )
    db.commit()
    csrf = login(client, "admin", "secret-password")

    client.patch(
        "/api/v1/instance-settings",
        json=DEFAULT_PAYLOAD,
        headers={"X-CSRF-Token": csrf},
    )

    def failing_send(settings, *, recipient, rendered):
        raise RuntimeError("SMTP server unreachable")

    monkeypatch.setattr("app.instance_settings.routes.send_smtp_email", failing_send)

    response = client.post(
        "/api/v1/instance-settings/test-email",
        headers={"X-CSRF-Token": csrf},
    )
    assert response.status_code == 200
    assert response.json() == {"sent": False, "error": "SMTP server unreachable"}


def test_test_email_requires_admin_email_on_file(client, db) -> None:
    create_user(db, "admin", "Administrator", "secret-password", is_admin=True)
    db.commit()
    csrf = login(client, "admin", "secret-password")

    response = client.post(
        "/api/v1/instance-settings/test-email",
        headers={"X-CSRF-Token": csrf},
    )
    assert response.status_code == 200
    assert response.json()["sent"] is False
