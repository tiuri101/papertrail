from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.accounts.dependencies import get_current_user
from app.accounts.models import User
from app.audit.models import AuditEvent
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
    limit: int = Query(default=100, ge=1, le=500),
    admin: User = Depends(require_project_manager_csrf),
    db: Session = Depends(get_db),
):
    require_project_access(db, project_id, admin)
    rows = db.execute(
        select(AuditEvent, User.username)
        .outerjoin(User, User.id == AuditEvent.actor_id)
        .where(AuditEvent.project_id == project_id)
        .order_by(AuditEvent.created_at.desc())
        .limit(limit)
    )
    return [
        {
            "id": event.id,
            "createdAt": event.created_at,
            "actorUsername": actor_username,
            "action": event.action,
            "entityType": event.entity_type,
            "entityId": event.entity_id,
            "summary": event.summary,
            "metadata": event.event_metadata,
        }
        for event, actor_username in rows
    ]


@router.get("/projects/{project_id}/dashboard")
def get_project_dashboard(
    project_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    require_project_access(db, project_id, user)
    return project_dashboard(db, project_id)


@router.get("/projects/{project_id}/reviewer-progress")
def get_reviewer_progress(
    project_id: str,
    _: User = Depends(require_project_manager),
    db: Session = Depends(get_db),
):
    return reviewer_progress(db, project_id)
