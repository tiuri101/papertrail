from sqlalchemy import select

from app.accounts.models import User
from app.cli import bootstrap_admin


def test_bootstrap_admin_is_idempotent(db) -> None:
    created = bootstrap_admin(db, "admin", "Papertrail Admin", "strong-password")
    db.commit()
    assert created.is_admin is True

    same = bootstrap_admin(db, "ADMIN", "Changed Name", "other-password")
    db.commit()
    assert same.id == created.id
    assert db.scalar(select(User).where(User.username == "admin")) is created
