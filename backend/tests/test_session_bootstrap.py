from app.accounts.service import create_user


def test_browser_can_restore_csrf_token_from_active_session(client, db) -> None:
    create_user(db, "reviewer", "Reviewer", "secret-password")
    db.commit()
    login = client.post(
        "/api/v1/auth/login",
        json={"username": "reviewer", "password": "secret-password"},
    )
    assert login.status_code == 200
    restored = client.get("/api/v1/auth/session")
    assert restored.status_code == 200
    assert restored.json()["user"]["username"] == "reviewer"
    assert restored.json()["csrfToken"] == login.json()["csrfToken"]
