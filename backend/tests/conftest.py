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
from sqlalchemy import create_engine
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

if os.getenv("PYTEST_XDIST_WORKER") and not os.getenv(
    "PAPERTRAIL_TEST_DATABASE_URL", SQLITE_TEST_DATABASE_URL
).startswith("sqlite"):
    # Every test creates and drops the full schema in the configured database,
    # so parallel workers sharing one PostgreSQL database would wipe each
    # other's tables mid-test. Each in-memory SQLite engine is private.
    raise pytest.UsageError(
        "pytest -n (xdist) only works with the default in-memory SQLite test "
        "database; unset PAPERTRAIL_TEST_DATABASE_URL or run serially"
    )


def create_test_engine() -> Engine:
    database_url = os.getenv(
        "PAPERTRAIL_TEST_DATABASE_URL",
        SQLITE_TEST_DATABASE_URL,
    )

    if database_url.startswith("sqlite"):
        return create_engine(
            database_url,
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )

    return create_engine(
        database_url,
        pool_pre_ping=True,
    )


@pytest.fixture()
def session_factory():
    engine = create_test_engine()
    Base.metadata.create_all(engine)

    factory = sessionmaker(
        bind=engine,
        autoflush=False,
        expire_on_commit=False,
    )

    yield factory

    Base.metadata.drop_all(engine)
    engine.dispose()


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
