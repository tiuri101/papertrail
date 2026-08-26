from __future__ import annotations

from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.accounts.dependencies import get_current_user
from app.accounts.models import User
from app.audit.query import (
    DEFAULT_LIMIT,
    MAX_LIMIT,
    AuditFilters,
    audit_filter_options,
    audit_page,
)
from app.audit.service import project_dashboard, reviewer_progress
from app.db.session import get_db
from app.projects.dependencies import (
    require_project_manager,
    require_project_manager_csrf,
)
from app.projects.service import require_project_access

router = APIRouter(tags=["audit"])


@router.get("/projects/{project_id}/audit")
def list_audit_events(
    project_id: str,
    limit: int = Query(default=DEFAULT_LIMIT, ge=1, le=MAX_LIMIT),
    cursor: str | None = Query(
        default=None,
        description="`nextCursor` from the previous page. Opaque; do not construct.",
    ),
    action: str | None = Query(default=None),
    entity_type: str | None = Query(default=None, alias="entityType"),
    entity_id: str | None = Query(default=None, alias="entityId"),
    actor_id: str | None = Query(
        default=None,
        alias="actorId",
        description=(
            "A user id, or 'system' for the events no user performed."
        ),
    ),
    search: str | None = Query(default=None, description="Substring of the summary."),
    since: datetime | None = Query(default=None, description="Inclusive lower bound on createdAt."),
    until: datetime | None = Query(default=None, description="Inclusive upper bound on createdAt."),
    admin: User = Depends(require_project_manager_csrf),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    """One page of this project's audit log, newest first.

    Returns ``{items, total, hasMore, nextCursor}``: ``total`` counts every
    event matching the filters, so a reader is never left assuming the page
    in front of them is the whole history.
    """
    require_project_access(db, project_id, admin)
    page = audit_page(
        db,
        project_id,
        filters=AuditFilters(
            action=action,
            entity_type=entity_type,
            entity_id=entity_id,
            actor_id=actor_id,
            search=search,
            since=since,
            until=until,
        ),
        limit=limit,
        cursor=cursor,
    )
    return {
        "items": page.items,
        "total": page.total,
        "hasMore": page.has_more,
        "nextCursor": page.next_cursor,
    }


@router.get("/projects/{project_id}/audit/filters")
def list_audit_filter_options(
    project_id: str,
    admin: User = Depends(require_project_manager_csrf),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    """Every action, entity type and actor present in this project's log.

    Filter choices have to come from the whole table, not from the page a
    client happens to hold, or paging would silently shrink them.
    """
    require_project_access(db, project_id, admin)
    return audit_filter_options(db, project_id)


@router.get("/projects/{project_id}/dashboard")
def get_project_dashboard(
    project_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, int | str]:
    require_project_access(db, project_id, user)
    return project_dashboard(db, project_id)


@router.get("/projects/{project_id}/reviewer-progress")
def get_reviewer_progress(
    project_id: str,
    _: User = Depends(require_project_manager),
    db: Session = Depends(get_db),
) -> list[dict[str, Any]]:
    return reviewer_progress(db, project_id)
