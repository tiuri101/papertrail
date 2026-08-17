from __future__ import annotations

from fastapi import Depends, Header
from sqlalchemy.orm import Session

from app.api.errors import ForbiddenError
from app.db.session import get_db
from app.pdf_acquisition.models import BrowserAgent
from app.pdf_acquisition.service import authenticate_agent


def _extract_bearer_token(authorization: str | None) -> str | None:
    if not authorization:
        return None
    scheme, _, value = authorization.partition(" ")
    if scheme.lower() != "bearer" or not value.strip():
        return None
    return value.strip()


def get_current_browser_agent(
    db: Session = Depends(get_db),
    authorization: str | None = Header(default=None),
) -> BrowserAgent:
    """Authenticates a paired Chrome extension via its own opaque bearer
    token. Entirely separate from the session-cookie/CSRF mechanism used by
    the Papertrail web UI -- this token cannot be substituted for it, and a
    session cookie cannot be used here."""
    agent = authenticate_agent(db, _extract_bearer_token(authorization))
    if agent is None:
        raise ForbiddenError("Invalid or revoked browser agent credentials")
    return agent
