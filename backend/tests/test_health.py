from fastapi.testclient import TestClient

from app.main import create_app


def test_health_endpoint() -> None:
    with TestClient(create_app()) as client:
        response = client.get("/health")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    # Unauthenticated -- must not hand an unauthenticated scanner the exact
    # running application version. See tests/security/test_production_config.py.
    assert "version" not in body
    assert response.headers["X-Request-ID"]
