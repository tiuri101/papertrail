from __future__ import annotations

import tomllib
from pathlib import Path

from app.core.config import Settings


BACKEND_ROOT = Path(__file__).resolve().parents[1]
PROJECT_ROOT = BACKEND_ROOT.parent


def test_editable_install_discovers_only_application_packages() -> None:
    configuration = tomllib.loads((BACKEND_ROOT / "pyproject.toml").read_text(encoding="utf-8"))

    package_discovery = configuration["tool"]["setuptools"]["packages"]["find"]

    assert package_discovery["include"] == ["app*"]
    assert set(package_discovery["exclude"]) == {"data*", "migrations*", "tests*"}


def test_development_environment_example_matches_host_process_setup() -> None:
    settings = Settings(_env_file=PROJECT_ROOT / ".env.development.example")

    assert settings.database_url.endswith("@localhost:5432/papertrail")
    assert settings.cors_origins == ["http://localhost:5173"]
    assert settings.session_cookie_secure is False
    assert settings.import_dir == Path("./data/imports")


def test_development_compose_contains_only_postgresql() -> None:
    compose = (PROJECT_ROOT / "docker-compose.dev.yml").read_text(encoding="utf-8")

    assert "  postgres:" in compose
    for production_service in ("api", "worker", "frontend", "gateway", "migrate"):
        assert f"  {production_service}:" not in compose
