from __future__ import annotations

from collections.abc import Generator
from urllib.parse import quote, urlsplit, urlunsplit

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import get_settings

settings = get_settings()


def _effective_database_url(url: str, role: str | None, password: str | None) -> str:
    """Swap in the least-privilege runtime role when one is configured.

    The migration/bootstrap process (Alembic, ``app.cli create-admin``) never
    sets PAPERTRAIL_RUNTIME_DATABASE_ROLE/PASSWORD, so it keeps connecting as
    the schema-owning identity embedded in PAPERTRAIL_DATABASE_URL. The API and
    the workers do set them, so this module's engine connects as the DML-only
    runtime role instead, without either process needing a different database
    URL to be templated in deployment configuration.
    """
    if not role or not password:
        return url
    parsed = urlsplit(url)
    host_port = parsed.hostname or ""
    if parsed.port:
        host_port += f":{parsed.port}"
    netloc = f"{quote(role, safe='')}:{quote(password, safe='')}@{host_port}"
    return urlunsplit((parsed.scheme, netloc, parsed.path, parsed.query, parsed.fragment))


engine = create_engine(
    _effective_database_url(
        settings.database_url,
        settings.runtime_database_role,
        settings.runtime_database_password,
    ),
    pool_pre_ping=True,
)
SessionFactory = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def get_db() -> Generator[Session, None, None]:
    session = SessionFactory()
    try:
        yield session
    finally:
        session.close()
