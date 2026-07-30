from __future__ import annotations

import argparse
import getpass
import os

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.accounts.models import User
from app.accounts.service import create_user
from app.db.session import SessionFactory


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
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.command != "create-admin":
        return 2
    password = args.password or getpass.getpass("Administrator password: ")
    if len(password) < 12:
        raise SystemExit("Administrator password must contain at least 12 characters")
    with SessionFactory() as db:
        user = bootstrap_admin(db, args.username, args.display_name, password)
        db.commit()
        print(f"Administrator ready: {user.username}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
