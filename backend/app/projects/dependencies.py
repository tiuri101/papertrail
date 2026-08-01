from __future__ import annotations

from fastapi import Depends
from sqlalchemy.orm import Session

from app.accounts.dependencies import get_current_user, require_csrf
from app.accounts.models import User, UserSession
from app.api.errors import ForbiddenError
from app.db.session import get_db
from app.projects.service import (
    is_any_project_manager,
    is_project_manager,
    require_project_access,
)


def require_project_manager(
    project_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> User:
    if not is_project_manager(db, project_id, user):
        raise ForbiddenError("Project owner or administrator access required")
    return user


def require_any_project_manager(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> User:
    """Authorize an action not scoped to one project (e.g. browsing the
    shared template catalog) to any project owner or the administrator."""
    if not is_any_project_manager(db, user):
        raise ForbiddenError("Project owner or administrator access required")
    return user


def require_project_manager_csrf(
    project_id: str,
    session: UserSession = Depends(require_csrf),
    db: Session = Depends(get_db),
) -> User:
    if not is_project_manager(db, project_id, session.user):
        raise ForbiddenError("Project owner or administrator access required")
    return session.user


def require_project_member_csrf(
    project_id: str,
    session: UserSession = Depends(require_csrf),
    db: Session = Depends(get_db),
) -> User:
    require_project_access(db, project_id, session.user)
    return session.user
