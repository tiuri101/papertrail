from __future__ import annotations

from fastapi import Cookie, Depends, Header, Request
from sqlalchemy.orm import Session

from app.accounts.models import User, UserSession
from app.accounts.service import find_active_session
from app.api.errors import ForbiddenError
from app.core.config import get_settings
from app.db.session import get_db


def get_current_session(
    request: Request,
    db: Session = Depends(get_db),
    session_cookie: str | None = Cookie(
        default=None, alias=get_settings().session_cookie_name
    ),
) -> UserSession:
    session = find_active_session(db, session_cookie)
    if session is None:
        raise ForbiddenError("Authentication required")
    request.state.user_session = session
    return session


def get_current_user(session: UserSession = Depends(get_current_session)) -> User:
    return session.user


def require_admin(user: User = Depends(get_current_user)) -> User:
    if not user.is_admin:
        raise ForbiddenError("Administrator access required")
    return user


def require_csrf(
    session: UserSession = Depends(get_current_session),
    csrf_token: str | None = Header(default=None, alias="X-CSRF-Token"),
) -> UserSession:
    if not csrf_token or not secrets_compare(csrf_token, session.csrf_token):
        raise ForbiddenError("Invalid CSRF token")
    return session


def require_admin_csrf(
    session: UserSession = Depends(require_csrf),
) -> User:
    if not session.user.is_admin:
        raise ForbiddenError("Administrator access required")
    return session.user


def secrets_compare(left: str, right: str) -> bool:
    import secrets

    return secrets.compare_digest(left, right)
