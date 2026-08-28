from datetime import timedelta

import pytest
from sqlalchemy import select

from app.accounts.models import LoginThrottle
from app.accounts.service import (
    clear_login_failures,
    create_user,
    ensure_login_allowed,
    ensure_password_reset_allowed,
    login_identity_hash,
    record_login_failure,
    record_password_reset_attempt,
)
from app.api.errors import RateLimitError
from app.audit.models import AuditEvent
from app.core.config import Settings, get_settings
from app.core.time import utcnow
from app.notifications.encryption import decrypt_payload
from app.notifications.models import EmailNotification
from app.notifications.service import _payload_associated_data


def test_admin_can_create_and_disable_reviewer(client, db) -> None:
    create_user(db, "admin", "Administrator", "secret-password", is_admin=True)
    db.commit()

    login = client.post(
        "/api/v1/auth/login", json={"username": "admin", "password": "secret-password"}
    )
    assert login.status_code == 200
    csrf = login.json()["csrfToken"]

    created = client.post(
        "/api/v1/users",
        json={
            "username": "reviewer",
            "displayName": "Reviewer",
            "password": "reviewer-password",
        },
        headers={"X-CSRF-Token": csrf},
    )
    assert created.status_code == 201
    reviewer_id = created.json()["id"]
    assert created.json()["isAdmin"] is False

    disabled = client.patch(
        f"/api/v1/users/{reviewer_id}",
        json={"isActive": False},
        headers={"X-CSRF-Token": csrf},
    )
    assert disabled.status_code == 200
    assert disabled.json()["isActive"] is False

    client.post("/api/v1/auth/logout", headers={"X-CSRF-Token": csrf})
    rejected = client.post(
        "/api/v1/auth/login",
        json={"username": "reviewer", "password": "reviewer-password"},
    )
    assert rejected.status_code == 401

    events = (
        db.query(AuditEvent)
        .filter(AuditEvent.entity_type == "user", AuditEvent.entity_id == reviewer_id)
        .order_by(AuditEvent.created_at)
        .all()
    )
    assert [event.action for event in events] == ["user.created", "user.updated"]
    assert events[1].event_metadata["fields"] == ["is_active"]


def test_mutation_requires_csrf(client, db) -> None:
    create_user(db, "admin", "Administrator", "secret-password", is_admin=True)
    db.commit()
    assert (
        client.post(
            "/api/v1/auth/login",
            json={"username": "admin", "password": "secret-password"},
        ).status_code
        == 200
    )
    response = client.post(
        "/api/v1/users",
        json={
            "username": "reviewer",
            "displayName": "Reviewer",
            "password": "reviewer-password",
        },
    )
    assert response.status_code == 403


def test_reviewer_can_neither_list_nor_manage_users(client, db) -> None:
    create_user(db, "reviewer", "Reviewer", "reviewer-password", is_admin=False)
    db.commit()
    login = client.post(
        "/api/v1/auth/login",
        json={"username": "reviewer", "password": "reviewer-password"},
    )
    csrf = login.json()["csrfToken"]
    assert login.status_code == 200

    # The installation-wide user directory is administrator-only: an ordinary
    # reviewer must not be able to enumerate everyone on the instance. Project
    # owners get the candidates they need from the project-scoped
    # /projects/{id}/member-candidates endpoint instead.
    list_response = client.get("/api/v1/users")
    assert list_response.status_code == 403

    create_response = client.post(
        "/api/v1/users",
        json={
            "username": "someoneelse",
            "displayName": "Someone Else",
            "password": "another-password",
        },
        headers={"X-CSRF-Token": csrf},
    )
    assert create_response.status_code == 403


def test_reviewer_can_update_own_display_name_and_password(client, db) -> None:
    create_user(db, "reviewer", "Reviewer", "reviewer-password", is_admin=False)
    db.commit()
    login = client.post(
        "/api/v1/auth/login",
        json={"username": "reviewer", "password": "reviewer-password"},
    )
    csrf = login.json()["csrfToken"]

    renamed = client.patch(
        "/api/v1/auth/me",
        json={"displayName": "New Name"},
        headers={"X-CSRF-Token": csrf},
    )
    assert renamed.status_code == 200
    assert renamed.json()["displayName"] == "New Name"

    wrong_current = client.patch(
        "/api/v1/auth/me",
        json={"currentPassword": "wrong-password", "newPassword": "new-password-1"},
        headers={"X-CSRF-Token": csrf},
    )
    assert wrong_current.status_code == 400

    unchanged = client.patch(
        "/api/v1/auth/me",
        json={
            "currentPassword": "reviewer-password",
            "newPassword": "reviewer-password",
        },
        headers={"X-CSRF-Token": csrf},
    )
    assert unchanged.status_code == 400
    assert unchanged.json()["error"]["message"] == (
        "New password must be different from your current password"
    )

    changed = client.patch(
        "/api/v1/auth/me",
        json={"currentPassword": "reviewer-password", "newPassword": "new-password-1"},
        headers={"X-CSRF-Token": csrf},
    )
    assert changed.status_code == 200

    still_logged_in = client.get("/api/v1/auth/me")
    assert still_logged_in.status_code == 200

    client.cookies.clear()
    old_password_rejected = client.post(
        "/api/v1/auth/login",
        json={"username": "reviewer", "password": "reviewer-password"},
    )
    assert old_password_rejected.status_code == 401

    new_password_accepted = client.post(
        "/api/v1/auth/login",
        json={"username": "reviewer", "password": "new-password-1"},
    )
    assert new_password_accepted.status_code == 200


def test_reviewer_can_persist_ui_preferences_without_an_audit_entry(client, db) -> None:
    user = create_user(db, "reviewer", "Reviewer", "reviewer-password", is_admin=False)
    reviewer_id = user.id
    db.commit()
    login = client.post(
        "/api/v1/auth/login",
        json={"username": "reviewer", "password": "reviewer-password"},
    )
    csrf = login.json()["csrfToken"]

    preferences = {
        "screeningHotkeys": {"include": "i", "exclude": "e"},
        "paperTextDisplay": {"fontFamily": "serif", "fontSize": "lg"},
    }
    updated = client.patch(
        "/api/v1/auth/me",
        json={"uiPreferences": preferences},
        headers={"X-CSRF-Token": csrf},
    )
    assert updated.status_code == 200
    assert updated.json()["uiPreferences"] == preferences

    # Preferences persist across sessions.
    session = client.get("/api/v1/auth/me")
    assert session.json()["uiPreferences"] == preferences

    # Cosmetic-only changes don't spam the audit log.
    events = (
        db.query(AuditEvent)
        .filter(AuditEvent.entity_type == "user", AuditEvent.entity_id == reviewer_id)
        .all()
    )
    assert events == []

    oversized = client.patch(
        "/api/v1/auth/me",
        json={"uiPreferences": {"blob": "x" * 25_000}},
        headers={"X-CSRF-Token": csrf},
    )
    assert oversized.status_code == 422


def test_admin_created_user_must_change_password_on_first_login(client, db) -> None:
    create_user(db, "admin", "Administrator", "secret-password", is_admin=True)
    db.commit()
    admin_login = client.post(
        "/api/v1/auth/login", json={"username": "admin", "password": "secret-password"}
    )
    admin_csrf = admin_login.json()["csrfToken"]

    created = client.post(
        "/api/v1/users",
        json={
            "username": "newbie",
            "displayName": "Newbie",
            "password": "temporary-password",
        },
        headers={"X-CSRF-Token": admin_csrf},
    )
    assert created.status_code == 201
    assert created.json()["mustChangePassword"] is True

    client.cookies.clear()
    login = client.post(
        "/api/v1/auth/login",
        json={"username": "newbie", "password": "temporary-password"},
    )
    assert login.status_code == 200
    assert login.json()["user"]["mustChangePassword"] is True
    csrf = login.json()["csrfToken"]

    unchanged = client.patch(
        "/api/v1/auth/me",
        json={
            "currentPassword": "temporary-password",
            "newPassword": "temporary-password",
        },
        headers={"X-CSRF-Token": csrf},
    )
    assert unchanged.status_code == 400
    assert unchanged.json()["error"]["message"] == (
        "New password must be different from your current password"
    )
    assert client.get("/api/v1/auth/me").json()["mustChangePassword"] is True

    changed = client.patch(
        "/api/v1/auth/me",
        json={
            "currentPassword": "temporary-password",
            "newPassword": "chosen-password",
        },
        headers={"X-CSRF-Token": csrf},
    )
    assert changed.status_code == 200
    assert changed.json()["mustChangePassword"] is False

    client.cookies.clear()
    relogin = client.post(
        "/api/v1/auth/login",
        json={"username": "newbie", "password": "chosen-password"},
    )
    assert relogin.status_code == 200
    assert relogin.json()["user"]["mustChangePassword"] is False


def test_admin_password_reset_forces_change_on_next_login(client, db) -> None:
    create_user(db, "admin", "Administrator", "secret-password", is_admin=True)
    reviewer = create_user(db, "reviewer", "Reviewer", "reviewer-password")
    db.commit()
    admin_login = client.post(
        "/api/v1/auth/login", json={"username": "admin", "password": "secret-password"}
    )
    admin_csrf = admin_login.json()["csrfToken"]

    reset = client.patch(
        f"/api/v1/users/{reviewer.id}",
        json={"password": "reset-password"},
        headers={"X-CSRF-Token": admin_csrf},
    )
    assert reset.status_code == 200
    assert reset.json()["mustChangePassword"] is True

    client.cookies.clear()
    login = client.post(
        "/api/v1/auth/login",
        json={"username": "reviewer", "password": "reset-password"},
    )
    assert login.status_code == 200
    assert login.json()["user"]["mustChangePassword"] is True


def _enable_email(settings: Settings) -> dict[str, object]:
    original = {
        "email_enabled": settings.email_enabled,
        "smtp_host": settings.smtp_host,
        "smtp_from_address": settings.smtp_from_address,
        "public_base_url": settings.public_base_url,
    }
    settings.email_enabled = True
    settings.smtp_host = "smtp.example.org"
    settings.smtp_from_address = "papertrail@example.org"
    settings.public_base_url = "https://papertrail.example.org"
    return original


def _restore_settings(settings: Settings, original: dict[str, object]) -> None:
    for key, value in original.items():
        setattr(settings, key, value)


def test_forgot_password_emails_a_single_use_reset_link(client, db) -> None:
    settings = get_settings()
    original = _enable_email(settings)
    try:
        create_user(
            db, "reviewer", "Reviewer", "old-password", email="reviewer@example.org"
        )
        db.commit()

        response = client.post(
            "/api/v1/auth/forgot-password", json={"email": "Reviewer@Example.org"}
        )
        assert response.status_code == 204

        notification = db.scalar(select(EmailNotification))
        assert notification is not None
        assert notification.template == "password_reset"
        assert notification.recipient_email == "reviewer@example.org"
        # The link is a credential, so it is never stored in the plain context
        # JSON -- only the worker, holding the application key, can read it.
        assert "reset_url" not in notification.context
        assert notification.encrypted_context is not None
        reset_url = decrypt_payload(
            notification.encrypted_context,
            associated_data=_payload_associated_data(
                notification.template, notification.recipient_email
            ),
        )["reset_url"]
        token = reset_url.rsplit("token=", 1)[1]

        wrong_token = client.post(
            "/api/v1/auth/reset-password",
            json={"token": "not-a-real-token", "newPassword": "brand-new-password"},
        )
        assert wrong_token.status_code == 400
        assert wrong_token.json()["error"]["code"] == "invalid_reset_token"

        reset = client.post(
            "/api/v1/auth/reset-password",
            json={"token": token, "newPassword": "brand-new-password"},
        )
        assert reset.status_code == 200
        assert reset.json()["user"]["username"] == "reviewer"
        assert "csrfToken" in reset.json()

        session = client.get("/api/v1/auth/me")
        assert session.status_code == 200

        client.cookies.clear()
        old_password_rejected = client.post(
            "/api/v1/auth/login",
            json={"username": "reviewer", "password": "old-password"},
        )
        assert old_password_rejected.status_code == 401
        new_password_accepted = client.post(
            "/api/v1/auth/login",
            json={"username": "reviewer", "password": "brand-new-password"},
        )
        assert new_password_accepted.status_code == 200

        reused = client.post(
            "/api/v1/auth/reset-password",
            json={"token": token, "newPassword": "another-password"},
        )
        assert reused.status_code == 400
    finally:
        _restore_settings(settings, original)


def test_forgot_password_does_not_reveal_whether_an_account_exists(client, db) -> None:
    settings = get_settings()
    original = _enable_email(settings)
    try:
        response = client.post(
            "/api/v1/auth/forgot-password",
            json={"email": "nobody@example.org"},
        )
        assert response.status_code == 204
        assert list(db.scalars(select(EmailNotification))) == []
    finally:
        _restore_settings(settings, original)


def test_reset_password_rejects_expired_or_unknown_token(client) -> None:
    response = client.post(
        "/api/v1/auth/reset-password",
        json={"token": "never-issued", "newPassword": "brand-new-password"},
    )
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "invalid_reset_token"


def test_update_me_current_password_is_rate_limited(client, db) -> None:
    create_user(db, "reviewer", "Reviewer", "reviewer-password", is_admin=False)
    db.commit()
    login = client.post(
        "/api/v1/auth/login",
        json={"username": "reviewer", "password": "reviewer-password"},
    )
    csrf = login.json()["csrfToken"]

    settings = get_settings()
    original_attempts = settings.login_max_attempts
    settings.login_max_attempts = 2
    try:
        for _ in range(2):
            wrong = client.patch(
                "/api/v1/auth/me",
                json={
                    "currentPassword": "wrong-password",
                    "newPassword": "new-password-1",
                },
                headers={"X-CSRF-Token": csrf},
            )
            assert wrong.status_code == 400

        blocked = client.patch(
            "/api/v1/auth/me",
            json={
                "currentPassword": "reviewer-password",
                "newPassword": "new-password-1",
            },
            headers={"X-CSRF-Token": csrf},
        )
        assert blocked.status_code == 429
        assert blocked.json()["error"]["code"] == "rate_limited"
    finally:
        settings.login_max_attempts = original_attempts


def test_forgot_password_is_rate_limited_per_email_and_client(client, db) -> None:
    create_user(
        db, "reviewer", "Reviewer", "old-password", email="reviewer@example.org"
    )
    db.commit()
    settings = get_settings()
    original_attempts = settings.password_reset_max_attempts
    settings.password_reset_max_attempts = 2
    try:
        assert (
            client.post(
                "/api/v1/auth/forgot-password", json={"email": "reviewer@example.org"}
            ).status_code
            == 204
        )
        assert (
            client.post(
                "/api/v1/auth/forgot-password", json={"email": "reviewer@example.org"}
            ).status_code
            == 204
        )
        blocked = client.post(
            "/api/v1/auth/forgot-password", json={"email": "reviewer@example.org"}
        )
        assert blocked.status_code == 429
        assert blocked.json()["error"]["code"] == "rate_limited"
    finally:
        settings.password_reset_max_attempts = original_attempts


def _throttle_row(db, identity: str) -> LoginThrottle | None:
    return db.scalar(
        select(LoginThrottle).where(LoginThrottle.identity_hash == identity)
    )


def test_login_throttle_mechanics_full_lifecycle(db) -> None:
    """Exercise the shared throttle helper via the login call sites: first
    failure, reaching the limit, window expiration resetting the count, a
    blocked identity being rejected, block expiration allowing retry, and a
    successful login clearing the throttle."""
    create_user(db, "reviewer", "Reviewer", "correct-password")
    db.commit()
    settings = get_settings()
    original_attempts = settings.login_max_attempts
    original_window = settings.login_window_seconds
    original_block = settings.login_block_seconds
    settings.login_max_attempts = 3
    settings.login_window_seconds = 900
    settings.login_block_seconds = 900
    username, client_address = "reviewer", "203.0.113.5"
    identity = login_identity_hash(username, client_address)
    try:
        # No throttle row yet -- allowed.
        ensure_login_allowed(db, username, client_address)

        # First failure: recorded, still allowed.
        record_login_failure(db, username, client_address)
        db.commit()
        throttle = _throttle_row(db, identity)
        assert throttle is not None
        assert throttle.attempts == 1
        assert throttle.blocked_until is None
        ensure_login_allowed(db, username, client_address)

        # Reach the configured limit -> blocked.
        record_login_failure(db, username, client_address)
        record_login_failure(db, username, client_address)
        db.commit()
        db.refresh(throttle)
        assert throttle.attempts == 3
        assert throttle.blocked_until is not None
        with pytest.raises(RateLimitError):
            ensure_login_allowed(db, username, client_address)

        # Block expiration allows retry again.
        throttle.blocked_until = utcnow() - timedelta(seconds=1)
        db.commit()
        ensure_login_allowed(db, username, client_address)

        # Window expiration resets the attempt count on the next failure.
        throttle.window_started_at = utcnow() - timedelta(
            seconds=settings.login_window_seconds + 1
        )
        throttle.blocked_until = None
        db.commit()
        record_login_failure(db, username, client_address)
        db.commit()
        db.refresh(throttle)
        assert throttle.attempts == 1
        assert throttle.blocked_until is None
        ensure_login_allowed(db, username, client_address)

        # A successful login clears the throttle entirely.
        clear_login_failures(db, username, client_address)
        db.commit()
        assert _throttle_row(db, identity) is None
        ensure_login_allowed(db, username, client_address)
    finally:
        settings.login_max_attempts = original_attempts
        settings.login_window_seconds = original_window
        settings.login_block_seconds = original_block


def test_password_reset_throttle_mechanics_full_lifecycle(db) -> None:
    """Exercise the same shared throttle helper via the password-reset call
    sites, confirming identical mechanics (first attempt, limit, window
    expiration, blocked state, block expiration) under the password-reset
    policy knobs (password_reset_max_attempts, not login_max_attempts)."""
    settings = get_settings()
    original_attempts = settings.password_reset_max_attempts
    original_window = settings.login_window_seconds
    original_block = settings.login_block_seconds
    settings.password_reset_max_attempts = 3
    settings.login_window_seconds = 900
    settings.login_block_seconds = 900
    email, client_address = "reviewer@example.org", "203.0.113.6"
    identity = login_identity_hash(f"pwreset:{email}", client_address)
    try:
        # No throttle row yet -- allowed.
        ensure_password_reset_allowed(db, email, client_address)

        # First attempt: recorded, still allowed.
        record_password_reset_attempt(db, email, client_address)
        db.commit()
        throttle = _throttle_row(db, identity)
        assert throttle is not None
        assert throttle.attempts == 1
        assert throttle.blocked_until is None
        ensure_password_reset_allowed(db, email, client_address)

        # Reach the configured limit -> blocked.
        record_password_reset_attempt(db, email, client_address)
        record_password_reset_attempt(db, email, client_address)
        db.commit()
        db.refresh(throttle)
        assert throttle.attempts == 3
        assert throttle.blocked_until is not None
        with pytest.raises(RateLimitError):
            ensure_password_reset_allowed(db, email, client_address)

        # Block expiration allows retry again.
        throttle.blocked_until = utcnow() - timedelta(seconds=1)
        db.commit()
        ensure_password_reset_allowed(db, email, client_address)

        # Window expiration resets the attempt count on the next attempt.
        throttle.window_started_at = utcnow() - timedelta(
            seconds=settings.login_window_seconds + 1
        )
        throttle.blocked_until = None
        db.commit()
        record_password_reset_attempt(db, email, client_address)
        db.commit()
        db.refresh(throttle)
        assert throttle.attempts == 1
        assert throttle.blocked_until is None
        ensure_password_reset_allowed(db, email, client_address)
    finally:
        settings.password_reset_max_attempts = original_attempts
        settings.login_window_seconds = original_window
        settings.login_block_seconds = original_block
