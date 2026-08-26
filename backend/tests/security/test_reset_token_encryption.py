"""A database read alone must not yield a usable password-reset token.

The dedicated `password_reset_tokens` table only ever stored a SHA-256 hash --
but the notification queue then wrote the *raw* reset URL into an ordinary JSON
column and left it there. Anyone who could read `email_notifications` (a
replica, a backup, an unrelated SQL injection) could take over every account
with an outstanding reset. The link is now sealed with AES-GCM under a key that
lives only in the process environment, and is wiped once the mail is delivered.
"""

from __future__ import annotations

import json
import logging

from sqlalchemy import inspect, select

from app.accounts.models import PasswordResetToken
from app.accounts.service import create_user
from app.core.config import get_settings
from app.jobs.models import BackgroundJob, JobStatus
from app.jobs.worker import execute_next_job
from app.notifications.encryption import decrypt_payload
from app.notifications.models import EmailDeliveryStatus, EmailNotification
from app.notifications.service import _payload_associated_data
from tests.security.helpers import login

REVIEWER_PASSWORD = "reviewer-password-value"
REVIEWER_EMAIL = "reviewer@example.org"
NEW_PASSPHRASE = "a whole new passphrase"


def _enable_email(monkeypatch):
    settings = get_settings()
    monkeypatch.setattr(settings, "email_enabled", True)
    monkeypatch.setattr(settings, "smtp_host", "smtp.example.org")
    monkeypatch.setattr(settings, "smtp_from_address", "papertrail@example.org")
    monkeypatch.setattr(settings, "public_base_url", "https://papertrail.example.org")
    return settings


def _reviewer(db):
    user = create_user(
        db, "reviewer", "Reviewer", REVIEWER_PASSWORD, email=REVIEWER_EMAIL
    )
    db.commit()
    return user


def _request_reset(client) -> None:
    response = client.post(
        "/api/v1/auth/forgot-password", json={"email": REVIEWER_EMAIL}
    )
    assert response.status_code == 204


def _persisted_strings(db) -> list[str]:
    """Everything a `SELECT *` over the notification queue would hand over."""
    values: list[str] = []
    for notification in db.scalars(select(EmailNotification)):
        for attribute in inspect(EmailNotification).mapper.column_attrs:
            value = getattr(notification, attribute.key)
            if value is None:
                continue
            values.append(
                json.dumps(value, default=str)
                if isinstance(value, dict | list)
                else str(value)
            )
    for job in db.scalars(select(BackgroundJob)):
        values.append(json.dumps(job.payload, default=str))
    for token in db.scalars(select(PasswordResetToken)):
        values.append(token.token_hash)
    return values


def _raw_token(db) -> str:
    notification = db.scalar(select(EmailNotification))
    assert notification is not None
    assert notification.encrypted_context is not None
    payload = decrypt_payload(
        notification.encrypted_context,
        associated_data=_payload_associated_data(
            notification.template, notification.recipient_email
        ),
    )
    return str(payload["reset_url"]).rsplit("token=", 1)[1]


def test_queued_reset_link_is_absent_from_every_persisted_column(
    client, db, monkeypatch
) -> None:
    _enable_email(monkeypatch)
    _reviewer(db)

    _request_reset(client)
    db.expire_all()

    token = _raw_token(db)
    assert len(token) > 20  # a real secret, not an empty placeholder

    for value in _persisted_strings(db):
        assert token not in value, "raw reset token found in a persisted column"
        assert "reset-password?token=" not in value

    # The dedicated reset-token table keeps only a hash, as it always did.
    stored = db.scalar(select(PasswordResetToken))
    assert stored is not None
    assert stored.token_hash != token
    assert len(stored.token_hash) == 64


def test_database_contents_alone_cannot_produce_a_working_token(
    client, db, monkeypatch
) -> None:
    _enable_email(monkeypatch)
    _reviewer(db)
    _request_reset(client)
    db.expire_all()

    # Try every string a database reader could lift -- token hashes, the
    # ciphertext envelope, the deduplication key, the whole context blob -- as
    # a reset token. None of them may be accepted.
    candidates = set(_persisted_strings(db))
    notification = db.scalar(select(EmailNotification))
    assert notification is not None
    assert notification.encrypted_context is not None
    candidates.add(notification.encrypted_context)

    for candidate in candidates:
        response = client.post(
            "/api/v1/auth/reset-password",
            json={"token": candidate[:512], "newPassword": NEW_PASSPHRASE},
        )
        assert response.status_code == 400
        assert response.json()["error"]["code"] == "invalid_reset_token"

    client.cookies.clear()
    assert login(client, "reviewer", REVIEWER_PASSWORD)


def test_worker_holding_the_key_sends_a_usable_reset_link(
    client, db, session_factory, monkeypatch
) -> None:
    _enable_email(monkeypatch)
    _reviewer(db)
    sent: list[str] = []

    def fake_send(_settings, *, recipient, rendered) -> None:
        sent.append(rendered.text_body)

    monkeypatch.setattr("app.notifications.service.send_smtp_email", fake_send)

    _request_reset(client)
    assert execute_next_job(session_factory, "test-worker") is True
    db.expire_all()

    assert len(sent) == 1
    token = sent[0].rsplit("token=", 1)[1].split()[0]
    reset = client.post(
        "/api/v1/auth/reset-password",
        json={"token": token, "newPassword": NEW_PASSPHRASE},
    )
    assert reset.status_code == 200

    notification = db.scalar(select(EmailNotification))
    assert notification is not None
    assert notification.status == EmailDeliveryStatus.SENT
    # Delivered: nothing is left behind, not even the ciphertext.
    assert notification.encrypted_context is None

    client.cookies.clear()
    assert login(client, "reviewer", NEW_PASSPHRASE)


def test_wrong_key_fails_the_job_without_leaking_secret_material(
    client, db, session_factory, monkeypatch, caplog
) -> None:
    settings = _enable_email(monkeypatch)
    _reviewer(db)

    def fake_send(*_args, **_kwargs) -> None:  # pragma: no cover - must not run
        raise AssertionError("an undecryptable email must never be sent")

    monkeypatch.setattr("app.notifications.service.send_smtp_email", fake_send)
    _request_reset(client)
    db.expire_all()
    token = _raw_token(db)

    # Simulate the key having been rotated (or restored from the wrong
    # environment file) between queueing and delivery.
    monkeypatch.setattr(
        settings, "notification_encryption_key", "rotated-" + "k" * 40
    )

    with caplog.at_level(logging.DEBUG):
        for _ in range(5):
            assert execute_next_job(session_factory, "test-worker") is True

    db.expire_all()
    job = db.scalar(select(BackgroundJob).where(BackgroundJob.job_type == "send_email"))
    notification = db.scalar(select(EmailNotification))
    assert job is not None
    assert job.status == JobStatus.FAILED
    assert notification is not None
    assert notification.status == EmailDeliveryStatus.FAILED

    # Administrators get enough to diagnose the misconfiguration...
    diagnosis = f"{job.error_message or ''} {notification.error_message or ''}"
    assert "could not be decrypted" in diagnosis
    assert "PAPERTRAIL_NOTIFICATION_ENCRYPTION_KEY" in diagnosis

    # ... and nothing that helps them, or a log reader, take over the account.
    haystack = f"{diagnosis} {caplog.text} " + " ".join(_persisted_strings(db))
    assert token not in haystack
    assert settings.notification_encryption_key not in haystack


def test_without_a_configured_key_no_reset_link_is_queued_or_leaked(
    client, db, monkeypatch, caplog
) -> None:
    settings = _enable_email(monkeypatch)
    monkeypatch.setattr(settings, "notification_encryption_key", None)
    _reviewer(db)

    with caplog.at_level(logging.ERROR):
        known = client.post(
            "/api/v1/auth/forgot-password", json={"email": REVIEWER_EMAIL}
        )
        unknown = client.post(
            "/api/v1/auth/forgot-password", json={"email": "nobody@example.org"}
        )

    # Fail closed, but identically for both -- a misconfigured instance must
    # not turn into an account-existence oracle.
    assert known.status_code == unknown.status_code == 204
    assert known.text == unknown.text
    assert db.scalar(select(EmailNotification)) is None
    assert db.scalar(select(PasswordResetToken)) is None
    assert "PAPERTRAIL_NOTIFICATION_ENCRYPTION_KEY" in caplog.text
