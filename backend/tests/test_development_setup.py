from __future__ import annotations

import tomllib
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
PROJECT_ROOT = BACKEND_ROOT.parent


def test_editable_install_discovers_only_application_packages() -> None:
    configuration = tomllib.loads(
        (BACKEND_ROOT / "pyproject.toml").read_text(encoding="utf-8")
    )

    package_discovery = configuration["tool"]["setuptools"]["packages"]["find"]

    assert package_discovery["include"] == ["app*"]
    assert set(package_discovery["exclude"]) == {"data*", "migrations*", "tests*"}


def test_development_compose_contains_only_postgresql() -> None:
    compose = (PROJECT_ROOT / "docker-compose.dev.yml").read_text(encoding="utf-8")

    assert "  postgres:" in compose
    for production_service in ("api", "worker", "frontend", "gateway", "migrate"):
        assert f"  {production_service}:" not in compose


def test_powershell_start_launches_general_and_llm_workers() -> None:
    script = (PROJECT_ROOT / "scripts" / "dev.ps1").read_text(encoding="utf-8")

    assert "Invoke-BackendPython -m app.jobs.worker\n" in script
    assert "Invoke-BackendPython -m app.jobs.worker --llm" in script
    assert '@("api", "worker", "llm-worker", "frontend")' in script
