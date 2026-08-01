from __future__ import annotations

import contextlib
import hashlib
import secrets
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.accounts.models import User, UserSession
from app.api.errors import ConflictError, NotFoundError
from app.core.config import get_settings

password_hasher = PasswordHasher()

# Hashed once at import time and verified against on the "no such user" path
# below, so that authenticate() takes the same time whether or not the
# username exists -- otherwise the skipped Argon2 verify makes username
# existence observable via response timing.
_DUMMY_PASSWORD_HASH = password_hasher.hash(secrets.token_urlsafe(32))


def utcnow() -> datetime:
    return datetime.now(UTC)


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def create_user(
    db: Session,
    username: str,
    display_name: str,
    password: str,
    *,
    is_admin: bool = False,
) -> User:
    normalized_username = username.strip().lower()
    if db.scalar(select(User).where(User.username == normalized_username)):
        raise ConflictError("A user with this username already exists")
    user = User(
        username=normalized_username,
        display_name=display_name.strip(),
        password_hash=password_hasher.hash(password),
        is_admin=is_admin,
    )
    db.add(user)
    db.flush()
    return user


def verify_password(user: User, password: str) -> bool:
    try:
        password_hasher.verify(user.password_hash, password)
    except VerifyMismatchError:
        return False
    return True


def authenticate(db: Session, username: str, password: str) -> User | None:
    user = db.scalar(select(User).where(User.username == username.strip().lower()))
    if user is None or not user.is_active:
        with contextlib.suppress(VerifyMismatchError):
            password_hasher.verify(_DUMMY_PASSWORD_HASH, password)
        return None
    try:
        password_hasher.verify(user.password_hash, password)
    except VerifyMismatchError:
        return None
    if password_hasher.check_needs_rehash(user.password_hash):
        user.password_hash = password_hasher.hash(password)
    user.last_login_at = utcnow()
    return user


@dataclass(frozen=True)
class CreatedSession:
    session: UserSession
    raw_token: str


def create_session(db: Session, user: User) -> CreatedSession:
    settings = get_settings()
    now = utcnow()
    raw_token = secrets.token_urlsafe(48)
    session = UserSession(
        user_id=user.id,
        token_hash=hash_token(raw_token),
        csrf_token=secrets.token_urlsafe(32),
        created_at=now,
        expires_at=now + timedelta(hours=settings.session_ttl_hours),
    )
    db.add(session)
    db.flush()
    return CreatedSession(session=session, raw_token=raw_token)


def find_active_session(db: Session, raw_token: str | None) -> UserSession | None:
    if not raw_token:
        return None
    session = db.scalar(
        select(UserSession).where(
            UserSession.token_hash == hash_token(raw_token),
            UserSession.revoked_at.is_(None),
        )
    )
    if session is None:
        return None
    expires_at = session.expires_at
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=UTC)
    if expires_at <= utcnow() or not session.user.is_active:
        return None
    return session


def revoke_session(session: UserSession) -> None:
    session.revoked_at = utcnow()


def get_user_or_raise(db: Session, user_id: str) -> User:
    user = db.get(User, user_id)
    if user is None:
        raise NotFoundError("User not found")
    return user


def login_identity_hash(username: str, client_address: str) -> str:
    value = f"{username.strip().lower()}:{client_address}".encode()
    return hashlib.sha256(value).hexdigest()


def ensure_login_allowed(db: Session, username: str, client_address: str) -> None:
    from app.accounts.models import LoginThrottle
    from app.api.errors import RateLimitError

    identity = login_identity_hash(username, client_address)
    throttle = db.scalar(
        select(LoginThrottle).where(LoginThrottle.identity_hash == identity)
    )
    if throttle is None or throttle.blocked_until is None:
        return
    blocked_until = throttle.blocked_until
    if blocked_until.tzinfo is None:
        blocked_until = blocked_until.replace(tzinfo=UTC)
    if blocked_until > utcnow():
        raise RateLimitError("Too many failed login attempts. Try again later.")


def record_login_failure(db: Session, username: str, client_address: str) -> None:
    from app.accounts.models import LoginThrottle

    settings = get_settings()
    now = utcnow()
    identity = login_identity_hash(username, client_address)
    throttle = db.scalar(
        select(LoginThrottle).where(LoginThrottle.identity_hash == identity)
    )
    if throttle is None:
        throttle = LoginThrottle(
            identity_hash=identity,
            attempts=0,
            window_started_at=now,
        )
        db.add(throttle)
        db.flush()
    window_started_at = throttle.window_started_at
    if window_started_at.tzinfo is None:
        window_started_at = window_started_at.replace(tzinfo=UTC)
    if now - window_started_at > timedelta(seconds=settings.login_window_seconds):
        throttle.attempts = 0
        throttle.window_started_at = now
        throttle.blocked_until = None
    throttle.attempts += 1
    if throttle.attempts >= settings.login_max_attempts:
        throttle.blocked_until = now + timedelta(seconds=settings.login_block_seconds)
    db.flush()


def clear_login_failures(db: Session, username: str, client_address: str) -> None:
    from app.accounts.models import LoginThrottle

    identity = login_identity_hash(username, client_address)
    throttle = db.scalar(
        select(LoginThrottle).where(LoginThrottle.identity_hash == identity)
    )
    if throttle is not None:
        db.delete(throttle)
        db.flush()
