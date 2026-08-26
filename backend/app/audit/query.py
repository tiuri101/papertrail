"""Filtering and paging one project's audit log.

The audit log is the one table in Papertrail that only ever grows, and it
grows fastest on exactly the projects whose history someone needs to read.
Serving it as a single capped list -- as this endpoint used to -- had two
consequences that a reader could not see from the outside: everything past
the newest ``limit`` rows was simply unreachable, and the filters offered in
the UI narrowed *that page*, so a search that found nothing was
indistinguishable from a project where the thing being searched for never
happened.

So filtering and ordering belong here, on the server, over the whole table,
with pagination that a client can follow to the end.

**Keyset, not offset.** New events are written while someone is reading, and
they are written at the *front* of a newest-first ordering: an offset page 2
fetched a second later re-shows rows page 1 already had. A cursor anchored to
the last row of the previous page is unaffected by anything inserted ahead of
it.

**The cursor is an event id.** ``AuditEvent.id`` is a UUID and carries no
ordering of its own, so the sort key is ``(created_at, id)`` -- the timestamp
for the actual order, the id purely to break ties, since a burst of events
recorded in one transaction can share a timestamp exactly. Rather than
serializing that composite key into the cursor and parsing a timezone back
out of it on the way in, the cursor names the row and the row's own key is
read back from the database. It is opaque to clients either way, and it makes
the comparison the database performs a comparison of stored values against
stored values.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any

from sqlalchemy import ColumnElement, Select, and_, func, or_, select
from sqlalchemy.orm import Session

from app.accounts.models import User
from app.api.errors import DomainError
from app.audit.models import AuditEvent

#: Sentinel accepted in place of a user id, matching the events no user
#: performed (a background handler, a scheduled sweep). Those rows hold
#: ``actor_id IS NULL``, which cannot be expressed as an id.
SYSTEM_ACTOR = "system"

DEFAULT_LIMIT = 100
MAX_LIMIT = 500


@dataclass(frozen=True)
class AuditFilters:
    """The narrowing a caller asked for. Every field is optional."""

    action: str | None = None
    entity_type: str | None = None
    entity_id: str | None = None
    actor_id: str | None = None
    search: str | None = None
    since: datetime | None = None
    until: datetime | None = None


@dataclass(frozen=True)
class AuditPage:
    items: list[dict[str, Any]]
    total: int
    has_more: bool
    next_cursor: str | None


class InvalidAuditCursorError(DomainError):
    """A cursor that names no event in this project.

    400 rather than 404: the *project* exists, the cursor is what is wrong --
    typically a hand-edited value, or one from a different project.
    """

    code = "invalid_cursor"


def _filter_clauses(
    project_id: str, filters: AuditFilters
) -> list[ColumnElement[bool]]:
    clauses: list[ColumnElement[bool]] = [AuditEvent.project_id == project_id]
    if filters.action:
        clauses.append(AuditEvent.action == filters.action)
    if filters.entity_type:
        clauses.append(AuditEvent.entity_type == filters.entity_type)
    if filters.entity_id:
        clauses.append(AuditEvent.entity_id == filters.entity_id)
    if filters.actor_id == SYSTEM_ACTOR:
        clauses.append(AuditEvent.actor_id.is_(None))
    elif filters.actor_id:
        clauses.append(AuditEvent.actor_id == filters.actor_id)
    if filters.search:
        # Summaries are the human-readable half of an event and the only part
        # worth free-text searching; `action` is matched exactly through its
        # own filter.
        clauses.append(AuditEvent.summary.ilike(f"%{filters.search}%"))
    if filters.since is not None:
        clauses.append(AuditEvent.created_at >= filters.since)
    if filters.until is not None:
        clauses.append(AuditEvent.created_at <= filters.until)
    return clauses


def _ordered(query: Select[Any]) -> Select[Any]:
    """Newest first, with a total order so pages cannot overlap or skip."""
    return query.order_by(AuditEvent.created_at.desc(), AuditEvent.id.desc())


def _after_cursor(
    db: Session, project_id: str, cursor: str
) -> ColumnElement[bool]:
    """The keyset predicate for "strictly older than the cursor's event"."""
    anchor = db.execute(
        select(AuditEvent.created_at, AuditEvent.id).where(
            AuditEvent.id == cursor, AuditEvent.project_id == project_id
        )
    ).first()
    if anchor is None:
        raise InvalidAuditCursorError("Unknown audit cursor")
    created_at, event_id = anchor
    return or_(
        AuditEvent.created_at < created_at,
        and_(AuditEvent.created_at == created_at, AuditEvent.id < event_id),
    )


def audit_page(
    db: Session,
    project_id: str,
    *,
    filters: AuditFilters | None = None,
    limit: int = DEFAULT_LIMIT,
    cursor: str | None = None,
) -> AuditPage:
    """One page of a project's audit log, newest first.

    ``total`` counts every event matching ``filters``, not just this page, so
    a client can say how much of the history it is showing instead of implying
    that the page is all there is.
    """
    limit = max(1, min(limit, MAX_LIMIT))
    clauses = _filter_clauses(project_id, filters or AuditFilters())

    total = (
        db.scalar(select(func.count()).select_from(AuditEvent).where(*clauses)) or 0
    )

    page_clauses = list(clauses)
    if cursor:
        page_clauses.append(_after_cursor(db, project_id, cursor))

    # One extra row answers "is there another page?" without a second count.
    rows = db.execute(
        _ordered(
            select(AuditEvent, User.display_name)
            .outerjoin(User, User.id == AuditEvent.actor_id)
            .where(*page_clauses)
        ).limit(limit + 1)
    ).all()

    has_more = len(rows) > limit
    rows = rows[:limit]

    items = [
        {
            "id": event.id,
            "createdAt": event.created_at,
            "actorUsername": actor_display_name,
            "action": event.action,
            "entityType": event.entity_type,
            "entityId": event.entity_id,
            "summary": event.summary,
            "metadata": event.event_metadata,
        }
        for event, actor_display_name in rows
    ]
    return AuditPage(
        items=items,
        total=int(total),
        has_more=has_more,
        next_cursor=items[-1]["id"] if has_more and items else None,
    )


def audit_filter_options(db: Session, project_id: str) -> dict[str, Any]:
    """Every value a project's audit log can be filtered by.

    Filter dropdowns used to be built from whichever rows happened to be
    loaded, which -- now that a page is a page -- would offer a shrinking,
    arbitrary subset of the real choices and hide the rest of the history
    behind a filter the reader never knew existed. These come from the whole
    table.
    """
    actions = sorted(
        db.scalars(
            select(AuditEvent.action)
            .where(AuditEvent.project_id == project_id)
            .distinct()
        )
    )
    entity_types = sorted(
        db.scalars(
            select(AuditEvent.entity_type)
            .where(AuditEvent.project_id == project_id)
            .distinct()
        )
    )
    actor_rows = db.execute(
        select(AuditEvent.actor_id, User.display_name)
        .outerjoin(User, User.id == AuditEvent.actor_id)
        .where(AuditEvent.project_id == project_id)
        .distinct()
    ).all()
    actors = [
        {"id": actor_id or SYSTEM_ACTOR, "name": display_name or "System"}
        for actor_id, display_name in actor_rows
    ]
    actors.sort(key=lambda actor: actor["name"])
    return {"actions": actions, "entityTypes": entity_types, "actors": actors}
