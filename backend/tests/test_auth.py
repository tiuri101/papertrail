from app.accounts.service import create_user
from app.audit.models import AuditEvent


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


def test_reviewer_can_list_but_not_manage_users(client, db) -> None:
    create_user(db, "reviewer", "Reviewer", "reviewer-password", is_admin=False)
    db.commit()
    login = client.post(
        "/api/v1/auth/login",
        json={"username": "reviewer", "password": "reviewer-password"},
    )
    csrf = login.json()["csrfToken"]
    assert login.status_code == 200

    # Any authenticated user can see the user directory (needed to add project
    # members), but only an admin can create or update accounts.
    list_response = client.get("/api/v1/users")
    assert list_response.status_code == 200

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
