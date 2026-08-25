from __future__ import annotations

import contextlib
import hashlib
import secrets
from dataclasses import dataclass
from datetime import UTC, timedelta
from email.utils import parseaddr

from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError
from sqlalchemy import delete, or_, select
from sqlalchemy.orm import Session

from app.accounts.models import LoginThrottle, PasswordResetToken, User, UserSession
from app.accounts.password_policy import validate_password_policy
from app.api.errors import ConflictError, DomainError, NotFoundError, RateLimitError
from app.core.config import get_settings
from app.core.time import utcnow
from app.instance_settings.service import effective_instance_settings

password_hasher = PasswordHasher()

# Hashed once at import time and verified against on the "no such user" path
# below, so that authenticate() takes the same time whether or not the
# username exists -- otherwise the skipped Argon2 verify makes username
# existence observable via response timing.
_DUMMY_PASSWORD_HASH = password_hasher.hash(secrets.token_urlsafe(32))


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def create_user(
    db: Session,
    username: str,
    display_name: str,
    password: str,
    *,
    is_admin: bool = False,
    email: str | None = None,
    must_change_password: bool = False,
) -> User:
    validate_password_policy(password)
    normalized_username = username.strip().lower()
    if db.scalar(select(User).where(User.username == normalized_username)):
        raise ConflictError("A user with this username already exists")
    normalized_email = normalize_email_address(email)
    if normalized_email and db.scalar(
        select(User).where(User.email == normalized_email)
    ):
        raise ConflictError("A user with this email address already exists")
    user = User(
        username=normalized_username,
        display_name=display_name.strip(),
        password_hash=password_hasher.hash(password),
        is_admin=is_admin,
        email=normalized_email,
        must_change_password=must_change_password,
    )
    db.add(user)
    db.flush()
    return user


def normalize_email_address(value: str | None) -> str | None:
    if value is None or not value.strip():
        return None
    candidate = value.strip().lower()
    parsed_name, parsed_address = parseaddr(candidate)
    local, separator, domain = parsed_address.rpartition("@")
    if (
        parsed_name
        or parsed_address != candidate
        or not separator
        or not local
        or not domain
        or any(character.isspace() for character in candidate)
        or any(character in candidate for character in "\r\n")
    ):
        raise DomainError("Enter a valid email address")
    return candidate


def set_user_email(db: Session, user: User, value: str | None) -> None:
    normalized = normalize_email_address(value)
    if normalized:
        existing = db.scalar(
            select(User).where(User.email == normalized, User.id != user.id)
        )
        if existing:
            raise ConflictError("A user with this email address already exists")
    user.email = normalized


def set_user_password(user: User, password: str) -> None:
    """The one place a password becomes a stored hash after account creation.

    Routing every change-password path (self service, emailed reset, admin
    reset) through here is what keeps the policy from being enforced on some
    endpoints and forgotten on others.
    """
    validate_password_policy(password)
    user.password_hash = password_hasher.hash(password)


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


@dataclass(frozen=True)
class CreatedPasswordResetToken:
    token: PasswordResetToken
    raw_token: str


def create_password_reset_token(db: Session, user: User) -> CreatedPasswordResetToken:
    settings = effective_instance_settings(db)
    now = utcnow()
    outstanding = db.scalars(
        select(PasswordResetToken).where(
            PasswordResetToken.user_id == user.id,
            PasswordResetToken.used_at.is_(None),
        )
    )
    for stale_token in outstanding:
        stale_token.used_at = now
    raw_token = secrets.token_urlsafe(32)
    token = PasswordResetToken(
        user_id=user.id,
        token_hash=hash_token(raw_token),
        created_at=now,
        expires_at=now + timedelta(minutes=settings.password_reset_ttl_minutes),
    )
    db.add(token)
    db.flush()
    return CreatedPasswordResetToken(token=token, raw_token=raw_token)


def find_valid_password_reset_token(
    db: Session, raw_token: str | None
) -> PasswordResetToken | None:
    if not raw_token:
        return None
    token = db.scalar(
        select(PasswordResetToken).where(
            PasswordResetToken.token_hash == hash_token(raw_token)
        )
    )
    if token is None or token.used_at is not None:
        return None
    expires_at = token.expires_at
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=UTC)
    if expires_at <= utcnow() or not token.user.is_active:
        return None
    return token


def consume_password_reset_token(db: Session, token: PasswordResetToken) -> None:
    token.used_at = utcnow()


def _ensure_throttle_allowed(db: Session, identity: str, error_message: str) -> None:
    throttle = db.scalar(
        select(LoginThrottle).where(LoginThrottle.identity_hash == identity)
    )
    if throttle is None or throttle.blocked_until is None:
        return
    blocked_until = throttle.blocked_until
    if blocked_until.tzinfo is None:
        blocked_until = blocked_until.replace(tzinfo=UTC)
    if blocked_until > utcnow():
        raise RateLimitError(error_message)


def _record_throttle_attempt(
    db: Session,
    identity: str,
    *,
    window_seconds: int,
    max_attempts: int,
    block_seconds: int,
) -> None:
    now = utcnow()
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
    if now - window_started_at > timedelta(seconds=window_seconds):
        throttle.attempts = 0
        throttle.window_started_at = now
        throttle.blocked_until = None
    throttle.attempts += 1
    if throttle.attempts >= max_attempts:
        throttle.blocked_until = now + timedelta(seconds=block_seconds)
    db.flush()


# A single account+IP counter is trivially sidestepped: rotate the source IP
# and every bucket is empty again, or hold the IP and rotate usernames. So each
# attempt is counted three times -- against the pair, against the account on its
# own, and against the source address on its own -- and any one of them can
# block. The broader the scope, the looser the limit, so that a shared NAT or a
# busy office does not lock out honest users before the pair counter fires.
ACCOUNT_SCOPE_ATTEMPT_MULTIPLIER = 3
ADDRESS_SCOPE_ATTEMPT_MULTIPLIER = 6

# Throttle rows are only interesting while their window (or block) is live.
# Left alone they accumulate one row per attempted username/address forever,
# which is a slow table-growth denial of service in its own right.
THROTTLE_RETENTION_MULTIPLIER = 4
THROTTLE_PRUNE_BATCH = 200


@dataclass(frozen=True)
class _ThrottleScope:
    identity: str
    max_attempts: int


def _scoped_identity_hash(scope: str, value: str) -> str:
    # The unit separator cannot appear in an email address or an IP literal, so
    # scopes cannot be made to collide with each other by choosing a username.
    payload = f"{scope}\x1f{value.strip().lower()}".encode()
    return hashlib.sha256(payload).hexdigest()


def login_identity_hash(username: str, client_address: str) -> str:
    """The account+address ("pair") throttle identity."""
    value = f"{username.strip().lower()}:{client_address}".encode()
    return hashlib.sha256(value).hexdigest()


def _login_scopes(
    username: str, client_address: str, max_attempts: int
) -> list[_ThrottleScope]:
    return [
        _ThrottleScope(login_identity_hash(username, client_address), max_attempts),
        _ThrottleScope(
            _scoped_identity_hash("login-account", username),
            max_attempts * ACCOUNT_SCOPE_ATTEMPT_MULTIPLIER,
        ),
        _ThrottleScope(
            _scoped_identity_hash("login-address", client_address),
            max_attempts * ADDRESS_SCOPE_ATTEMPT_MULTIPLIER,
        ),
    ]


def _password_reset_scopes(
    email: str, client_address: str, max_attempts: int
) -> list[_ThrottleScope]:
    return [
        _ThrottleScope(
            login_identity_hash(f"pwreset:{email}", client_address), max_attempts
        ),
        _ThrottleScope(
            _scoped_identity_hash("password-reset-account", email),
            max_attempts * ACCOUNT_SCOPE_ATTEMPT_MULTIPLIER,
        ),
        _ThrottleScope(
            _scoped_identity_hash("password-reset-address", client_address),
            max_attempts * ADDRESS_SCOPE_ATTEMPT_MULTIPLIER,
        ),
    ]


def prune_expired_throttles(db: Session, *, limit: int = THROTTLE_PRUNE_BATCH) -> int:
    """Delete throttle rows whose window and block are both long finished.

    Bounded on purpose: this runs inline on failed-authentication paths, so it
    must stay a small indexed delete rather than a full table sweep. Rows that
    are still blocking anyone are never touched.
    """
    settings = get_settings()
    retention_seconds = THROTTLE_RETENTION_MULTIPLIER * max(
        settings.login_window_seconds, settings.login_block_seconds, 1
    )
    now = utcnow()
    horizon = now - timedelta(seconds=retention_seconds)
    stale_ids = list(
        db.scalars(
            select(LoginThrottle.id)
            .where(
                LoginThrottle.window_started_at < horizon,
                or_(
                    LoginThrottle.blocked_until.is_(None),
                    LoginThrottle.blocked_until < now,
                ),
            )
            .limit(limit)
        )
    )
    if not stale_ids:
        return 0
    db.execute(delete(LoginThrottle).where(LoginThrottle.id.in_(stale_ids)))
    db.flush()
    return len(stale_ids)


def ensure_password_reset_allowed(db: Session, email: str, client_address: str) -> None:
    """Reject an over-budget reset request.

    Evaluated purely from the submitted address and the caller's IP, before any
    account lookup happens, so the outcome never depends on whether the account
    exists.
    """
    settings = effective_instance_settings(db)
    for scope in _password_reset_scopes(
        email, client_address, settings.password_reset_max_attempts
    ):
        _ensure_throttle_allowed(
            db, scope.identity, "Too many password reset requests. Try again later."
        )


def record_password_reset_attempt(db: Session, email: str, client_address: str) -> None:
    settings = effective_instance_settings(db)
    prune_expired_throttles(db)
    for scope in _password_reset_scopes(
        email, client_address, settings.password_reset_max_attempts
    ):
        _record_throttle_attempt(
            db,
            scope.identity,
            window_seconds=settings.login_window_seconds,
            max_attempts=scope.max_attempts,
            block_seconds=settings.login_block_seconds,
        )


def get_user_or_raise(db: Session, user_id: str) -> User:
    user = db.get(User, user_id)
    if user is None:
        raise NotFoundError("User not found")
    return user


def ensure_login_allowed(db: Session, username: str, client_address: str) -> None:
    settings = get_settings()
    for scope in _login_scopes(username, client_address, settings.login_max_attempts):
        _ensure_throttle_allowed(
            db, scope.identity, "Too many failed login attempts. Try again later."
        )


def record_login_failure(db: Session, username: str, client_address: str) -> None:
    settings = get_settings()
    prune_expired_throttles(db)
    for scope in _login_scopes(username, client_address, settings.login_max_attempts):
        _record_throttle_attempt(
            db,
            scope.identity,
            window_seconds=settings.login_window_seconds,
            max_attempts=scope.max_attempts,
            block_seconds=settings.login_block_seconds,
        )


def clear_login_failures(db: Session, username: str, client_address: str) -> None:
    """Reset the counters a successful authentication vindicates.

    The pair and the account are cleared: whoever just authenticated owns the
    account. The source-address counter deliberately survives -- otherwise one
    valid login would wipe the evidence of a username-spraying run coming from
    the same address.
    """
    identities = [
        login_identity_hash(username, client_address),
        _scoped_identity_hash("login-account", username),
    ]
    db.execute(delete(LoginThrottle).where(LoginThrottle.identity_hash.in_(identities)))
    db.flush()
