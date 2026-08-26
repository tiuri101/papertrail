"""Every path that sets a password enforces the same minimum length.

The audit found an 8-character floor, which is below anything defensible for a
password protecting a whole review's data. The risk of raising it is not the
number itself but *coverage*: a policy that lives in one schema and is quietly
missing from the admin reset, the emailed reset or the CLI bootstrap is not a
policy. So each case below picks the boundary (11 rejected, 12 accepted) and
drives it through a different entry point.
"""

from __future__ import annotations

import pytest
from sqlalchemy import select

from app.accounts.models import User
from app.accounts.password_policy import (
    MAX_PASSWORD_LENGTH,
    MIN_PASSWORD_LENGTH,
    password_policy_violation,
)
from app.accounts.service import create_password_reset_token, create_user
from app.api.errors import DomainError
from app.cli import main as cli_main
from tests.security.helpers import login

ADMIN_PASSWORD = "administrator-password"
REVIEWER_PASSWORD = "reviewer-password-value"

# Exactly one character short of the policy, and a long passphrase with no
# digits, symbols or capitals -- the kind of password the policy must accept.
TOO_SHORT = "a" * (MIN_PASSWORD_LENGTH - 1)
LONG_PASSPHRASE = "correct horse battery staple"


def _policy_message(response) -> str:
    return str(response.json()["error"]["message"])


def test_the_boundary_is_twelve_characters() -> None:
    assert MIN_PASSWORD_LENGTH >= 12
    assert len(TOO_SHORT) == MIN_PASSWORD_LENGTH - 1
    assert password_policy_violation(TOO_SHORT) is not None
    assert password_policy_violation("b" * MIN_PASSWORD_LENGTH) is None
    assert password_policy_violation(LONG_PASSPHRASE) is None
    # A pathological Argon2 input is still refused at the top end.
    assert password_policy_violation("c" * (MAX_PASSWORD_LENGTH + 1)) is not None


def test_admin_created_user_password_must_meet_the_policy(client, db) -> None:
    create_user(db, "admin", "Administrator", ADMIN_PASSWORD, is_admin=True)
    db.commit()
    csrf = login(client, "admin", ADMIN_PASSWORD)

    rejected = client.post(
        "/api/v1/users",
        json={
            "username": "weak",
            "displayName": "Weak",
            "password": TOO_SHORT,
        },
        headers={"X-CSRF-Token": csrf},
    )
    assert rejected.status_code == 400
    assert str(MIN_PASSWORD_LENGTH) in _policy_message(rejected)
    assert db.scalar(select(User).where(User.username == "weak")) is None

    accepted = client.post(
        "/api/v1/users",
        json={
            "username": "strong",
            "displayName": "Strong",
            "password": LONG_PASSPHRASE,
        },
        headers={"X-CSRF-Token": csrf},
    )
    assert accepted.status_code == 201

    # ... and the accepted passphrase really is the account's password.
    client.cookies.clear()
    assert login(client, "strong", LONG_PASSPHRASE)


def test_admin_issued_password_reset_must_meet_the_policy(client, db) -> None:
    create_user(db, "admin", "Administrator", ADMIN_PASSWORD, is_admin=True)
    reviewer = create_user(db, "reviewer", "Reviewer", REVIEWER_PASSWORD)
    db.commit()
    csrf = login(client, "admin", ADMIN_PASSWORD)

    rejected = client.patch(
        f"/api/v1/users/{reviewer.id}",
        json={"password": TOO_SHORT},
        headers={"X-CSRF-Token": csrf},
    )
    assert rejected.status_code == 400
    assert str(MIN_PASSWORD_LENGTH) in _policy_message(rejected)

    accepted = client.patch(
        f"/api/v1/users/{reviewer.id}",
        json={"password": LONG_PASSPHRASE},
        headers={"X-CSRF-Token": csrf},
    )
    assert accepted.status_code == 200

    client.cookies.clear()
    assert login(client, "reviewer", LONG_PASSPHRASE)


def test_self_service_password_change_must_meet_the_policy(client, db) -> None:
    create_user(db, "reviewer", "Reviewer", REVIEWER_PASSWORD)
    db.commit()
    csrf = login(client, "reviewer", REVIEWER_PASSWORD)

    rejected = client.patch(
        "/api/v1/auth/me",
        json={"currentPassword": REVIEWER_PASSWORD, "newPassword": TOO_SHORT},
        headers={"X-CSRF-Token": csrf},
    )
    assert rejected.status_code == 400
    assert str(MIN_PASSWORD_LENGTH) in _policy_message(rejected)

    accepted = client.patch(
        "/api/v1/auth/me",
        json={"currentPassword": REVIEWER_PASSWORD, "newPassword": LONG_PASSPHRASE},
        headers={"X-CSRF-Token": csrf},
    )
    assert accepted.status_code == 200

    client.cookies.clear()
    assert login(client, "reviewer", LONG_PASSPHRASE)


def test_emailed_reset_link_cannot_set_a_password_below_the_policy(
    client, db
) -> None:
    reviewer = create_user(
        db, "reviewer", "Reviewer", REVIEWER_PASSWORD, email="reviewer@example.org"
    )
    created = create_password_reset_token(db, reviewer)
    db.commit()

    rejected = client.post(
        "/api/v1/auth/reset-password",
        json={"token": created.raw_token, "newPassword": TOO_SHORT},
    )
    assert rejected.status_code == 400
    assert str(MIN_PASSWORD_LENGTH) in _policy_message(rejected)

    # The rejected attempt must not have burnt the token: the user gets to try
    # again with an acceptable passphrase using the same link.
    accepted = client.post(
        "/api/v1/auth/reset-password",
        json={"token": created.raw_token, "newPassword": LONG_PASSPHRASE},
    )
    assert accepted.status_code == 200

    client.cookies.clear()
    assert login(client, "reviewer", LONG_PASSPHRASE)


def test_cli_bootstrap_admin_shares_the_same_policy(
    session_factory, db, monkeypatch
) -> None:
    monkeypatch.setattr("app.cli.SessionFactory", session_factory)

    with pytest.raises(SystemExit) as rejected:
        cli_main(["create-admin", "--username", "root", "--password", TOO_SHORT])
    assert str(MIN_PASSWORD_LENGTH) in str(rejected.value)
    assert db.scalar(select(User).where(User.username == "root")) is None

    assert (
        cli_main(
            ["create-admin", "--username", "root", "--password", LONG_PASSPHRASE]
        )
        == 0
    )
    created = db.scalar(select(User).where(User.username == "root"))
    assert created is not None
    assert created.is_admin is True


def test_create_user_service_refuses_a_weak_password_directly(db) -> None:
    """The service, not just the route, is the boundary -- any future caller
    that skips the HTTP layer still cannot create a weak account."""
    with pytest.raises(DomainError):
        create_user(db, "backdoor", "Back Door", TOO_SHORT)
    assert db.scalar(select(User).where(User.username == "backdoor")) is None
