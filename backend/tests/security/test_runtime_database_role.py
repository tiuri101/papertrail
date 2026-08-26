"""Issue 11 regression tests: the API/workers connect as a least-privilege
runtime database role, never the schema-owning migration identity."""

from __future__ import annotations

import pytest
from sqlalchemy import create_engine, text

from app.db.runtime_role import _quote_identifier, ensure_runtime_role
from app.db.session import _effective_database_url


class TestEffectiveDatabaseUrl:
    def test_unchanged_when_no_runtime_role_configured(self) -> None:
        url = "postgresql+psycopg://owner:owner-pw@postgres:5432/papertrail"
        assert _effective_database_url(url, None, None) == url

    def test_unchanged_when_only_role_is_set(self) -> None:
        url = "postgresql+psycopg://owner:owner-pw@postgres:5432/papertrail"
        assert _effective_database_url(url, "papertrail_app", None) == url

    def test_swaps_in_runtime_credentials_when_both_are_set(self) -> None:
        url = "postgresql+psycopg://owner:owner-pw@postgres:5432/papertrail?sslmode=disable"
        effective = _effective_database_url(url, "papertrail_app", "runtime-pw")
        assert effective == (
            "postgresql+psycopg://papertrail_app:runtime-pw@postgres:5432/papertrail"
            "?sslmode=disable"
        )
        # The owner password must not survive into the connection the API/
        # workers actually use.
        assert "owner-pw" not in effective

    def test_percent_encodes_special_characters_in_runtime_credentials(self) -> None:
        url = "postgresql+psycopg://owner:owner-pw@postgres:5432/papertrail"
        effective = _effective_database_url(url, "app", "p@ss/word:1!")
        assert effective == "postgresql+psycopg://app:p%40ss%2Fword%3A1%21@postgres:5432/papertrail"


class TestQuoteIdentifier:
    @pytest.mark.parametrize("identifier", ["papertrail_app", "_role", "Role123"])
    def test_accepts_safe_identifiers(self, identifier: str) -> None:
        assert _quote_identifier(identifier) == f'"{identifier}"'

    @pytest.mark.parametrize(
        "identifier",
        [
            'robert"; DROP TABLE users; --',
            "role with spaces",
            "9leading-digit",
            "",
            "role-with-dash",
        ],
    )
    def test_rejects_unsafe_identifiers(self, identifier: str) -> None:
        with pytest.raises(ValueError, match="Refusing to use"):
            _quote_identifier(identifier)


class TestEnsureRuntimeRoleIsPostgresOnly:
    def test_noop_on_non_postgres_engine(self) -> None:
        engine = create_engine("sqlite+pysqlite:///:memory:")
        # Must not raise even though none of the PostgreSQL-only DDL below
        # would be valid SQLite syntax.
        ensure_runtime_role(engine, role="papertrail_app", password="x", database="papertrail")
        with engine.connect() as conn:
            # The engine must still be perfectly usable afterwards.
            assert conn.execute(text("SELECT 1")).scalar() == 1
