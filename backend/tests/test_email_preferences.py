from __future__ import annotations

import inspect
import re

import pytest
from sqlalchemy import select

from app.accounts.service import create_user
from app.core.config import Settings
from app.notifications.models import EmailNotification
from app.notifications.preferences import (
    EMAIL_CATEGORY_KEYS,
    MANDATORY_TEMPLATES,
    category_for_template,
)
from app.notifications.service import queue_email_notification
from app.notifications.templates import render_email


def email_settings(db=None) -> Settings:
    return Settings(
        _env_file=None,
        email_enabled=True,
        public_base_url="https://papertrail.example.org/",
        smtp_host="smtp.example.org",
        smtp_from_address="papertrail@example.org",
    )


def test_every_email_template_is_mandatory_or_in_a_category() -> None:
    templates = set(re.findall(r'template == "(\w+)"', inspect.getsource(render_email)))
    assert templates
    for template in templates:
        category = category_for_template(template)
        assert (template in MANDATORY_TEMPLATES) == (category is None)
    with pytest.raises(ValueError):
        category_for_template("brand_new_template")


def test_opted_out_category_is_not_queued(db, monkeypatch) -> None:
    monkeypatch.setattr(
        "app.notifications.service.effective_instance_settings", email_settings
    )
    user = create_user(db, "owner", "Owner", "secret-password", email="o@example.org")
    user.email_preferences = {"llm_processing": False}
    db.flush()

    skipped = queue_email_notification(
        db,
        recipient=user,
        template="llm_stage_completed",
        deduplication_key="llm",
        context={
            "recipient_name": "Owner",
            "project_name": "Review",
            "stage_label": "screening",
            "completed_count": 1,
            "failed_count": 0,
            "other_count": 0,
            "project_url": "https://papertrail.example.org/projects/p",
        },
    )
    sent = queue_email_notification(
        db,
        recipient=user,
        template="import_completed",
        deduplication_key="import",
        context={
            "recipient_name": "Owner",
            "project_name": "Review",
            "filename": "records.csv",
            "record_count": 3,
            "invalid_count": 0,
            "project_url": "https://papertrail.example.org/projects/p/imports",
        },
    )

    assert skipped is None
    assert sent is not None
    assert [n.template for n in db.scalars(select(EmailNotification))] == [
        "import_completed"
    ]


def test_mandatory_emails_ignore_preferences(db, monkeypatch) -> None:
    monkeypatch.setattr(
        "app.notifications.service.effective_instance_settings", email_settings
    )
    user = create_user(db, "owner", "Owner", "secret-password", email="o@example.org")
    user.email_preferences = {key: False for key in EMAIL_CATEGORY_KEYS}
    db.flush()

    notification = queue_email_notification(
        db,
        recipient=user,
        template="account_created",
        deduplication_key="welcome",
        context={
            "recipient_name": "Owner",
            "username": "owner",
            "login_url": "https://papertrail.example.org/login",
        },
    )

    assert notification is not None


def test_user_reads_and_updates_email_preferences(client, db) -> None:
    create_user(db, "reviewer", "Reviewer", "reviewer-password")
    db.commit()
    login = client.post(
        "/api/v1/auth/login",
        json={"username": "reviewer", "password": "reviewer-password"},
    )
    csrf = login.json()["csrfToken"]

    initial = client.get("/api/v1/auth/me").json()["emailPreferences"]
    assert initial == {key: True for key in sorted(EMAIL_CATEGORY_KEYS)}

    updated = client.patch(
        "/api/v1/auth/me",
        json={"emailPreferences": {"llm_processing": False}},
        headers={"X-CSRF-Token": csrf},
    )
    assert updated.status_code == 200
    assert updated.json()["emailPreferences"]["llm_processing"] is False

    # Partial updates merge instead of resetting other categories.
    client.patch(
        "/api/v1/auth/me",
        json={"emailPreferences": {"imports": False}},
        headers={"X-CSRF-Token": csrf},
    )
    current = client.get("/api/v1/auth/me").json()["emailPreferences"]
    assert current["llm_processing"] is False
    assert current["imports"] is False
    assert current["project_progress"] is True

    unknown = client.patch(
        "/api/v1/auth/me",
        json={"emailPreferences": {"password_reset": False}},
        headers={"X-CSRF-Token": csrf},
    )
    assert unknown.status_code == 422
