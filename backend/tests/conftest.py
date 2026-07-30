from __future__ import annotations

import os
from collections.abc import Generator

# Must be set before importing application modules.
os.environ.setdefault("PAPERTRAIL_ENV", "test")

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.db.base import Base
from app.db import models as _models
from app.db.session import get_db
from app.main import create_app


SQLITE_TEST_DATABASE_URL = "sqlite+pysqlite:///:memory:"


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