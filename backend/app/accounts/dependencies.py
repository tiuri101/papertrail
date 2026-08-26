from __future__ import annotations

from fastapi import Cookie, Depends, Header, Request
from sqlalchemy.orm import Session

from app.accounts.models import User, UserSession
from app.accounts.service import find_active_session
from app.api.errors import ForbiddenError
from app.core.config import get_settings
from app.db.session import get_db


class PasswordChangeRequiredError(ForbiddenError):
    """A valid session that is not yet fully authenticated.

    Distinct from a plain 403 so the client can tell "you may not do this" from
    "finish setting your password first" without inspecting the message.
    """

    code = "password_change_required"


def get_current_session(
    request: Request,
    db: Session = Depends(get_db),
    session_cookie: str
    | None = Cookie(default=None, alias=get_settings().session_cookie_name),
) -> UserSession:
    """A valid, unrevoked session for an active user.

    Deliberately does NOT imply the session may use the application: a user
    who still owes a mandatory password change gets a session so they can
    read it back, change the password, and log out -- nothing more. Only the
    handful of recovery endpoints should depend on this directly; everything
    else must go through `require_password_changed_session` (or the
    `get_current_user` / `require_csrf` wrappers built on it).
    """
    session = find_active_session(db, session_cookie)
    if session is None:
        raise ForbiddenError("Authentication required")
    request.state.user_session = session
    return session


def require_password_changed_session(
    session: UserSession = Depends(get_current_session),
) -> UserSession:
    """A fully authenticated session: valid, and no password change pending.

    `must_change_password` is an authentication state, not a UI hint. The
    frontend redirect to the change-password screen is a convenience; this is
    the boundary that actually holds when someone calls the API directly with
    the temporary password's session cookie.
    """
    if session.user.must_change_password:
        raise PasswordChangeRequiredError(
            "Set a new password before using the application"
        )
    return session


def get_current_user(
    session: UserSession = Depends(require_password_changed_session),
) -> User:
    return session.user


def require_admin(user: User = Depends(get_current_user)) -> User:
    if not user.is_admin:
        raise ForbiddenError("Administrator access required")
    return user


def verify_csrf(
    session: UserSession = Depends(get_current_session),
    csrf_token: str | None = Header(default=None, alias="X-CSRF-Token"),
) -> UserSession:
    """CSRF check only -- for the recovery endpoints (change password, log
    out) that a session owing a password change must still be able to call."""
    if not csrf_token or not secrets_compare(csrf_token, session.csrf_token):
        raise ForbiddenError("Invalid CSRF token")
    return session


def require_csrf(
    session: UserSession = Depends(verify_csrf),
) -> UserSession:
    """The CSRF dependency ordinary application endpoints use: a valid CSRF
    token *and* a fully authenticated session."""
    return require_password_changed_session(session)


def require_admin_csrf(
    session: UserSession = Depends(require_csrf),
) -> User:
    if not session.user.is_admin:
        raise ForbiddenError("Administrator access required")
    return session.user


def secrets_compare(left: str, right: str) -> bool:
    import secrets

    return secrets.compare_digest(left, right)
