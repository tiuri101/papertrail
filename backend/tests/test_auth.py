from app.accounts.service import create_user


def test_admin_can_create_and_disable_reviewer(client, db) -> None:
    admin = create_user(db, "admin", "Administrator", "secret-password", is_admin=True)
    db.commit()

    login = client.post("/api/v1/auth/login", json={"username": "admin", "password": "secret-password"})
    assert login.status_code == 200
    csrf = login.json()["csrfToken"]

    created = client.post(
        "/api/v1/users",
        json={"username": "reviewer", "displayName": "Reviewer", "password": "reviewer-password"},
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


def test_mutation_requires_csrf(client, db) -> None:
    create_user(db, "admin", "Administrator", "secret-password", is_admin=True)
    db.commit()
    assert client.post("/api/v1/auth/login", json={"username": "admin", "password": "secret-password"}).status_code == 200
    response = client.post(
        "/api/v1/users",
        json={"username": "reviewer", "displayName": "Reviewer", "password": "reviewer-password"},
    )
    assert response.status_code == 403


def test_reviewer_cannot_manage_users(client, db) -> None:
    create_user(db, "reviewer", "Reviewer", "reviewer-password", is_admin=False)
    db.commit()
    login = client.post("/api/v1/auth/login", json={"username": "reviewer", "password": "reviewer-password"})
    response = client.get("/api/v1/users")
    assert login.status_code == 200
    assert response.status_code == 403
