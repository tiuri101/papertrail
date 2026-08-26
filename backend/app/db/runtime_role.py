from __future__ import annotations

import logging
import re

from sqlalchemy import text
from sqlalchemy.engine import Engine

logger = logging.getLogger(__name__)

_SAFE_IDENTIFIER = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def _quote_identifier(identifier: str) -> str:
    # Role/database names come from trusted deployment configuration (the
    # operator's .env), never end-user input, but they cannot be passed as
    # bound query parameters -- SQL only allows literals there, not
    # identifiers -- so they are validated and quoted by hand instead.
    if not _SAFE_IDENTIFIER.match(identifier):
        raise ValueError(
            f"Refusing to use {identifier!r} as a database identifier: only "
            "letters, digits, and underscores are allowed, and it must not "
            "start with a digit."
        )
    return f'"{identifier}"'


def _quote_literal(value: str) -> str:
    # CREATE ROLE / ALTER ROLE are utility statements: PostgreSQL's parser
    # does not accept bind parameters inside them at all (only a plain string
    # literal), so the password has to be escaped and embedded by hand rather
    # than passed through SQLAlchemy's normal parameter binding. Postgres
    # defaults to standard_conforming_strings=on, so doubling embedded single
    # quotes is the correct/complete escaping rule for a quoted literal.
    return "'" + value.replace("'", "''") + "'"


def ensure_runtime_role(engine: Engine, *, role: str, password: str, database: str) -> None:
    """Idempotently create/refresh the least-privilege runtime database role.

    Grants DML only -- SELECT/INSERT/UPDATE/DELETE on tables, USAGE/SELECT on
    sequences -- never schema or role-management privileges. ``ALTER DEFAULT
    PRIVILEGES`` covers tables/sequences created by future migrations (which
    run as the same owner identity that calls this function) without needing
    to be re-run for every new table. Must be called with the schema-owning
    identity (the migration/bootstrap connection), not the runtime role
    itself. No-op on a non-PostgreSQL engine (e.g. local SQLite dev/test).
    """
    if engine.dialect.name != "postgresql":
        logger.info(
            "Skipping runtime database role provisioning: engine dialect is "
            "%s, not postgresql",
            engine.dialect.name,
        )
        return

    quoted_role = _quote_identifier(role)
    quoted_database = _quote_identifier(database)

    with engine.begin() as conn:
        exists = conn.execute(
            text("SELECT 1 FROM pg_roles WHERE rolname = :role"), {"role": role}
        ).first()
        quoted_password = _quote_literal(password)
        if exists:
            conn.execute(text(f"ALTER ROLE {quoted_role} LOGIN PASSWORD {quoted_password}"))
        else:
            conn.execute(text(f"CREATE ROLE {quoted_role} LOGIN PASSWORD {quoted_password}"))
        conn.execute(text(f"GRANT CONNECT ON DATABASE {quoted_database} TO {quoted_role}"))
        conn.execute(text(f"GRANT USAGE ON SCHEMA public TO {quoted_role}"))
        conn.execute(
            text(
                f"GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "
                f"public TO {quoted_role}"
            )
        )
        conn.execute(
            text(f"GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO {quoted_role}")
        )
        conn.execute(
            text(
                "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, "
                f"UPDATE, DELETE ON TABLES TO {quoted_role}"
            )
        )
        conn.execute(
            text(
                "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT "
                f"ON SEQUENCES TO {quoted_role}"
            )
        )
    logger.info("Ensured runtime database role is provisioned with DML-only privileges")
