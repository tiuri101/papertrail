from __future__ import annotations

import os
import secrets
from collections.abc import Generator

# Must be set before importing application modules.
os.environ.setdefault("PAPERTRAIL_ENV", "test")
# Sensitive email payloads (the password-reset link) are encrypted before they
# are persisted, so the suite needs an application key just like a real
# deployment. Generated per test run and never written down anywhere.
os.environ.setdefault(
    "PAPERTRAIL_NOTIFICATION_ENCRYPTION_KEY", secrets.token_urlsafe(48)
)

import pytest
from argon2 import PasswordHasher
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, make_url, text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

import app.accounts.service as account_service
from app.db.base import Base
from app.db.session import get_db
from app.main import create_app

# Production Argon2 parameters cost ~50 ms per hash and per verify, and the
# suite creates users and logs in well over a thousand times. The tests check
# *that* passwords are hashed and verified, not how expensive it is, so they
# run with the cheapest parameters argon2 accepts.
account_service.password_hasher = PasswordHasher(
    time_cost=1, memory_cost=8, parallelism=1
)
account_service._DUMMY_PASSWORD_HASH = account_service.password_hasher.hash(
    secrets.token_urlsafe(32)
)

SQLITE_TEST_DATABASE_URL = "sqlite+pysqlite:///:memory:"

def _test_database_url() -> str:
    return os.getenv("PAPERTRAIL_TEST_DATABASE_URL", SQLITE_TEST_DATABASE_URL)


def create_test_engine() -> Engine:
    """A private in-memory SQLite engine (the default)."""
    return create_engine(
        SQLITE_TEST_DATABASE_URL,
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )


@pytest.fixture(scope="session")
def postgres_test_engine() -> Generator[Engine | None, None, None]:
    """One scratch PostgreSQL database per test process, schema created once.

    Creating and dropping the full schema for every test cost ~1.5 s per test
    on PostgreSQL (40+ minutes for the suite in CI). Instead each process --
    each pytest-xdist worker included -- gets its own database derived from
    ``PAPERTRAIL_TEST_DATABASE_URL`` (``<name>_gw0``, ``<name>_gw1``, ...), so
    parallel workers never share tables, and tests are isolated by
    emptying every table afterwards. ``None`` when the suite runs on SQLite.
    """
    url = make_url(_test_database_url())
    if url.get_backend_name() != "postgresql":
        yield None
        return

    worker = os.getenv("PYTEST_XDIST_WORKER", "main")
    scratch_name = f"{url.database}_{worker}"
    admin_engine = create_engine(url, isolation_level="AUTOCOMMIT")
    with admin_engine.connect() as connection:
        connection.execute(text(f'DROP DATABASE IF EXISTS "{scratch_name}" WITH (FORCE)'))
        connection.execute(text(f'CREATE DATABASE "{scratch_name}"'))
    engine = create_engine(url.set(database=scratch_name), pool_pre_ping=True)
    Base.metadata.create_all(engine)
    try:
        yield engine
    finally:
        engine.dispose()
        with admin_engine.connect() as connection:
            connection.execute(
                text(f'DROP DATABASE IF EXISTS "{scratch_name}" WITH (FORCE)')
            )
        admin_engine.dispose()


def _empty_all_tables(engine: Engine) -> None:
    # DELETE rather than TRUNCATE: a test leaves a handful of rows behind, and
    # TRUNCATE's per-table file swap made it the slowest part of every test.
    # Children are emptied before their parents, all in one round trip.
    statements = "; ".join(
        f'DELETE FROM "{table.name}"' for table in reversed(Base.metadata.sorted_tables)
    )
    with engine.begin() as connection:
        # A test that left a session open would otherwise block the cleanup
        # forever. The database belongs to this process alone, so ending its
        # other connections cannot disturb anyone else.
        connection.execute(
            text(
                "SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
                "WHERE datname = current_database() AND pid <> pg_backend_pid()"
            )
        )
        connection.exec_driver_sql(statements)
    engine.dispose()


@pytest.fixture()
def session_factory(postgres_test_engine: Engine | None):
    engine = postgres_test_engine or create_test_engine()
    if postgres_test_engine is None:
        Base.metadata.create_all(engine)

    factory = sessionmaker(
        bind=engine,
        autoflush=False,
        expire_on_commit=False,
    )

    yield factory

    if postgres_test_engine is None:
        Base.metadata.drop_all(engine)
        engine.dispose()
    else:
        _empty_all_tables(engine)


@pytest.fixture()
def db(session_factory) -> Generator[Session, None, None]:
    session = session_factory()
    try:
        yield session
    finally:
        session.close()


@pytest.fixture()
def client(session_factory) -> Generator[TestClient, None, None]:
    app = create_app()

    def override_db():
        session = session_factory()
        try:
            yield session
        finally:
            session.close()

    app.dependency_overrides[get_db] = override_db

    with TestClient(app) as test_client:
        yield test_client

    app.dependency_overrides.clear()
