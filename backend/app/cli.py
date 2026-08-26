from __future__ import annotations

import argparse
import getpass
import os
from urllib.parse import urlsplit

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.accounts.models import User
from app.accounts.password_policy import (
    PASSWORD_REQUIREMENTS_TEXT,
    password_policy_violation,
)
from app.accounts.service import create_user
from app.core.config import get_settings
from app.db.runtime_role import ensure_runtime_role
from app.db.session import SessionFactory
from app.db.session import engine as db_engine


def bootstrap_admin(
    db: Session,
    username: str,
    display_name: str,
    password: str,
) -> User:
    """Create the installation administrator, or return the existing account."""
    normalized = username.strip().lower()
    existing = db.scalar(select(User).where(User.username == normalized))
    if existing is not None:
        if not existing.is_admin:
            raise ValueError(f"User '{normalized}' exists but is not an administrator")
        return existing
    return create_user(
        db,
        normalized,
        display_name,
        password,
        is_admin=True,
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="papertrail")
    subparsers = parser.add_subparsers(dest="command", required=True)
    create_admin = subparsers.add_parser(
        "create-admin",
        help="Create the installation administrator if it does not exist.",
    )
    create_admin.add_argument(
        "--username", default=os.getenv("PAPERTRAIL_ADMIN_USERNAME", "admin")
    )
    create_admin.add_argument(
        "--display-name",
        default=os.getenv("PAPERTRAIL_ADMIN_DISPLAY_NAME", "Papertrail Administrator"),
    )
    create_admin.add_argument(
        "--password", default=os.getenv("PAPERTRAIL_ADMIN_PASSWORD")
    )
    subparsers.add_parser(
        "ensure-runtime-role",
        help=(
            "Create/update the least-privilege runtime database role and grant "
            "it DML-only access (no-op on SQLite). Reads "
            "PAPERTRAIL_RUNTIME_DB_ROLE/PAPERTRAIL_RUNTIME_DB_PASSWORD from the "
            "environment, never from an argument, so the password never "
            "appears in a process listing."
        ),
    )
    return parser


def _ensure_runtime_role() -> int:
    role = os.getenv("PAPERTRAIL_RUNTIME_DB_ROLE")
    password = os.getenv("PAPERTRAIL_RUNTIME_DB_PASSWORD")
    if not role or not password:
        raise SystemExit(
            "PAPERTRAIL_RUNTIME_DB_ROLE and PAPERTRAIL_RUNTIME_DB_PASSWORD are "
            "both required for 'ensure-runtime-role'"
        )
    database = urlsplit(get_settings().database_url).path.lstrip("/")
    ensure_runtime_role(db_engine, role=role, password=password, database=database)
    print("Runtime database role ensured.")
    return 0


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.command == "ensure-runtime-role":
        return _ensure_runtime_role()
    if args.command != "create-admin":
        return 2
    password = args.password or getpass.getpass("Administrator password: ")
    # The same policy the API enforces -- imported, never restated, so the
    # bootstrap account can never be weaker than an account created in the UI.
    violation = password_policy_violation(password)
    if violation is not None:
        raise SystemExit(f"{violation}. {PASSWORD_REQUIREMENTS_TEXT}")
    with SessionFactory() as db:
        user = bootstrap_admin(db, args.username, args.display_name, password)
        db.commit()
        print(f"Administrator ready: {user.username}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
