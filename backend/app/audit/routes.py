from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.accounts.dependencies import get_current_user, require_admin_csrf
from app.accounts.models import User
from app.audit.models import AuditEvent
from app.audit.service import project_dashboard
from app.db.session import get_db
from app.projects.service import require_project_access

router = APIRouter(tags=["audit"])


@router.get("/projects/{project_id}/audit")
def list_audit_events(
    project_id: str,
    limit: int = Query(default=100, ge=1, le=500),
    admin: User = Depends(require_admin_csrf),
    db: Session = Depends(get_db),
):
    require_project_access(db, project_id, admin)
    events = db.scalars(
        select(AuditEvent)
        .where(AuditEvent.project_id == project_id)
        .order_by(AuditEvent.created_at.desc())
        .limit(limit)
    )
    return [
        {
            "id": event.id,
            "createdAt": event.created_at,
            "actorId": event.actor_id,
            "action": event.action,
            "entityType": event.entity_type,
            "entityId": event.entity_id,
            "summary": event.summary,
            "metadata": event.event_metadata,
        }
        for event in events
    ]


@router.get("/projects/{project_id}/dashboard")
def get_project_dashboard(
    project_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    require_project_access(db, project_id, user)
    return project_dashboard(db, project_id)
