"""`must_change_password` is an authentication state, not a UI hint.

Audit finding: the flag was enforced only by a frontend redirect, so a session
created with an administrator-issued temporary password had full API access --
anyone who could log in once with that password could read and mutate
everything the account was entitled to without ever setting a new one.
"""

from __future__ import annotations

from sqlalchemy import select

from app.accounts.models import User
from app.accounts.service import create_user
from app.projects.models import Project, ProjectMembership, ReviewType

TEMPORARY_PASSWORD = "temporary-password-value"
NEW_PASSWORD = "chosen-password-value"


def build_user_with_pending_change(db):
    user = create_user(
        db,
        "newcomer",
        "Newcomer",
        TEMPORARY_PASSWORD,
        must_change_password=True,
    )
    project = Project(
        name="Review", review_type=ReviewType.SYSTEMATIC_REVIEW, random_seed="seed"
    )
    db.add(project)
    db.flush()
    db.add(
        ProjectMembership(project_id=project.id, user_id=user.id, is_owner=True)
    )
    db.commit()
    return user, project


def login(client, username: str, password: str):
    return client.post(
        "/api/v1/auth/login", json={"username": username, "password": password}
    )


def test_temporary_password_session_is_limited_to_recovery_endpoints(
    client, db
) -> None:
    user, project = build_user_with_pending_change(db)

    signed_in = login(client, user.username, TEMPORARY_PASSWORD)
    assert signed_in.status_code == 200
    csrf = signed_in.json()["csrfToken"]
    assert signed_in.json()["user"]["mustChangePassword"] is True

    # Recovery endpoints stay reachable.
    assert client.get("/api/v1/auth/me").status_code == 200
    assert client.get("/api/v1/auth/session").status_code == 200

    # Ordinary application endpoints do not.
    for path in (
        "/api/v1/projects",
        f"/api/v1/projects/{project.id}",
        f"/api/v1/projects/{project.id}/checklist",
        # Sent with a valid CSRF token so the refusal can only come from the
        # pending password change, not from the CSRF check.
        f"/api/v1/projects/{project.id}/full-text/progress",
    ):
        blocked = client.get(path, headers={"X-CSRF-Token": csrf})
        assert blocked.status_code == 403, path
        assert blocked.json()["error"]["code"] == "password_change_required", path

    # ... and neither do write endpoints guarded by CSRF.
    created = client.post(
        "/api/v1/projects",
        json={"name": "Sneaky", "reviewType": "systematic_review"},
        headers={"X-CSRF-Token": csrf},
    )
    assert created.status_code == 403
    assert created.json()["error"]["code"] == "password_change_required"


def test_changing_the_password_restores_normal_access_on_the_same_session(
    client, db
) -> None:
    user, _ = build_user_with_pending_change(db)

    signed_in = login(client, user.username, TEMPORARY_PASSWORD)
    csrf = signed_in.json()["csrfToken"]
    assert client.get("/api/v1/projects").status_code == 403

    changed = client.patch(
        "/api/v1/auth/me",
        json={"currentPassword": TEMPORARY_PASSWORD, "newPassword": NEW_PASSWORD},
        headers={"X-CSRF-Token": csrf},
    )
    assert changed.status_code == 200, changed.text
    assert changed.json()["mustChangePassword"] is False

    # The very same session is now fully authenticated.
    assert client.get("/api/v1/projects").status_code == 200
    db.expire_all()
    stored = db.scalar(select(User).where(User.id == user.id))
    assert stored.must_change_password is False


def test_a_fresh_login_after_the_change_has_normal_access(client, db) -> None:
    user, _ = build_user_with_pending_change(db)

    csrf = login(client, user.username, TEMPORARY_PASSWORD).json()["csrfToken"]
    client.patch(
        "/api/v1/auth/me",
        json={"currentPassword": TEMPORARY_PASSWORD, "newPassword": NEW_PASSWORD},
        headers={"X-CSRF-Token": csrf},
    )
    client.cookies.clear()

    signed_in = login(client, user.username, NEW_PASSWORD)
    assert signed_in.status_code == 200
    assert signed_in.json()["user"]["mustChangePassword"] is False
    assert client.get("/api/v1/projects").status_code == 200


def test_logout_still_works_while_a_password_change_is_pending(client, db) -> None:
    user, _ = build_user_with_pending_change(db)

    csrf = login(client, user.username, TEMPORARY_PASSWORD).json()["csrfToken"]
    logged_out = client.post(
        "/api/v1/auth/logout", headers={"X-CSRF-Token": csrf}
    )
    assert logged_out.status_code == 204
    assert client.get("/api/v1/auth/me").status_code == 403


def test_an_admin_issued_password_reset_re_arms_the_requirement(client, db) -> None:
    admin = create_user(db, "root", "Root", "root-password-value", is_admin=True)
    reviewer = create_user(db, "reviewer", "Reviewer", "reviewer-password-value")
    db.commit()

    admin_csrf = login(client, admin.username, "root-password-value").json()[
        "csrfToken"
    ]
    reset = client.patch(
        f"/api/v1/users/{reviewer.id}",
        json={"password": "issued-password-value"},
        headers={"X-CSRF-Token": admin_csrf},
    )
    assert reset.status_code == 200
    assert reset.json()["mustChangePassword"] is True

    client.cookies.clear()
    login(client, reviewer.username, "issued-password-value")
    blocked = client.get("/api/v1/projects")
    assert blocked.status_code == 403
    assert blocked.json()["error"]["code"] == "password_change_required"
