"""Issue 13/27 regression tests: production fails closed on insecure defaults,
and interactive API docs/version disclosure are gated by environment."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.core.config import Settings, production_configuration_problems
from app.main import create_app

BASE_SECURE_KWARGS: dict[str, object] = {
    "env": "production",
    "session_cookie_secure": True,
    "public_base_url": "https://papers.example.org",
    "cors_origins": ["https://papers.example.org"],
    "allowed_hosts": ["papers.example.org"],
    "database_url": "postgresql+psycopg://app:S0me-Unique-Pw@postgres:5432/papertrail",
    "runtime_database_role": "papertrail_app",
    "runtime_database_password": "another-unique-pw",
    "notification_encryption_key": "a" * 48,
    "_env_file": None,
}


def _settings(**overrides: object) -> Settings:
    kwargs = {**BASE_SECURE_KWARGS, **overrides}
    return Settings(**kwargs)  # type: ignore[arg-type]


def test_secure_production_settings_construct_without_error() -> None:
    settings = _settings()
    assert settings.is_production
    assert production_configuration_problems(settings) == []


def test_insecure_cookie_is_rejected_in_production() -> None:
    with pytest.raises(ValueError, match="SESSION_COOKIE_SECURE"):
        _settings(session_cookie_secure=False)


def test_http_public_base_url_is_rejected_in_production() -> None:
    with pytest.raises(ValueError, match="PUBLIC_BASE_URL"):
        _settings(public_base_url="http://papers.example.org")


def test_wildcard_cors_is_rejected_in_production() -> None:
    with pytest.raises(ValueError, match="CORS_ORIGINS"):
        _settings(cors_origins=["*"])


def test_wildcard_allowed_hosts_is_rejected_in_production() -> None:
    with pytest.raises(ValueError, match="ALLOWED_HOSTS"):
        _settings(allowed_hosts=["*"])


def test_well_known_weak_database_password_is_rejected_in_production() -> None:
    with pytest.raises(ValueError, match="DATABASE_URL"):
        _settings(
            database_url="postgresql+psycopg://papertrail:change-me@postgres:5432/papertrail"
        )


def test_well_known_weak_runtime_password_is_rejected_in_production() -> None:
    with pytest.raises(ValueError, match="RUNTIME_DATABASE_PASSWORD"):
        _settings(runtime_database_password="change-me")


def test_well_known_weak_notification_key_is_rejected_in_production() -> None:
    with pytest.raises(ValueError, match="NOTIFICATION_ENCRYPTION_KEY"):
        _settings(notification_encryption_key="change-me")


def test_insecure_production_can_be_explicitly_allowed() -> None:
    settings = _settings(session_cookie_secure=False, allow_insecure_production=True)
    assert settings.session_cookie_secure is False


def test_development_env_is_not_held_to_production_rules() -> None:
    settings = Settings(env="development", session_cookie_secure=False, _env_file=None)
    assert not settings.is_production


def test_empty_compose_style_api_docs_value_is_treated_as_unset() -> None:
    """``PAPERTRAIL_API_DOCS_ENABLED: ${PAPERTRAIL_API_DOCS_ENABLED:-}`` renders
    as an empty string when the operator hasn't set it -- this must fall back
    to the environment default, not fail Settings construction. Caught by
    actually bringing up the Docker Compose stack (docker-compose.yml sets
    exactly this passthrough) rather than by static review."""
    settings = Settings(env="test", api_docs_enabled="", _env_file=None)  # type: ignore[arg-type]
    assert settings.api_docs_enabled is None


class TestDocsAndVersionDisclosure:
    def test_docs_enabled_by_default_outside_production(self) -> None:
        assert Settings(env="development", _env_file=None).docs_enabled is True
        assert Settings(env="test", _env_file=None).docs_enabled is True

    def test_docs_disabled_by_default_in_production(self) -> None:
        assert _settings().docs_enabled is False

    def test_docs_setting_can_be_overridden_explicitly(self) -> None:
        assert _settings(api_docs_enabled=True).docs_enabled is True
        assert Settings(
            env="development", api_docs_enabled=False, _env_file=None
        ).docs_enabled is False

    def test_production_app_hides_docs_and_openapi(self, monkeypatch: pytest.MonkeyPatch) -> None:
        # TestClient sends Host: testserver -- add it alongside the real
        # production hostname so TrustedHostMiddleware doesn't 400 every
        # request before routing even gets a chance to 404 on /docs.
        settings = _settings(allowed_hosts=["papers.example.org", "testserver"])
        monkeypatch.setattr("app.main.get_settings", lambda: settings)
        app = create_app()
        with TestClient(app, raise_server_exceptions=False) as client:
            assert client.get("/docs").status_code == 404
            assert client.get("/openapi.json").status_code == 404
            # Infrastructure health checks must never require auth or docs.
            assert client.get("/health").status_code == 200
            assert client.get("/ready").status_code == 200

    def test_development_app_still_serves_docs_and_openapi(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        settings = Settings(env="development", _env_file=None)
        monkeypatch.setattr("app.main.get_settings", lambda: settings)
        app = create_app()
        with TestClient(app) as client:
            assert client.get("/docs").status_code == 200
            assert client.get("/openapi.json").status_code == 200

    def test_health_response_never_names_the_app_version(self) -> None:
        # /health and /ready are unauthenticated; an exact version number is a
        # free "which advisories apply here" lookup for a scanner.
        from app.api.health import health, ready

        assert "version" not in health()
        assert "version" not in ready()

    def test_system_info_requires_admin(self, client: TestClient) -> None:
        assert client.get("/api/v1/system/info").status_code in (401, 403)
