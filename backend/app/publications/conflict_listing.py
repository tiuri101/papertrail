"""Filtering, sorting and paging one project's open metadata conflicts.

The "Metadata Conflicts" panel on the Publications page used to be served as
"every open ``MetadataConflict`` in the project", with the browser holding the
lot: a merge of two large imports, or a bulk enrichment run, can leave hundreds
of open conflicts behind, and each one carries a fully hydrated publication.

So narrowing and ordering belong here, over the whole table, with paging the
client can follow -- the same move ``app.publications.listing`` (publications)
and ``app.jobs.service`` (background jobs) already made, and built the same way:
offset pagination, a total order with an ``id`` tie-breaker so consecutive
pages can't overlap or skip, a ``sort`` allowlist with a safe fallback, and
project-wide aggregates computed independently of the active filters.

**Offset, not keyset.** Like the publication list and unlike the append-only
audit log, the ordering is chosen by the reader from a handful of keys (two of
them low-cardinality), and the set is comparatively stable -- conflicts arrive
in deliberate bulk (a merge, an enrichment sweep), not continuously while
somebody browses. Offset also gives the UI a total, a page count and the
ability to jump.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal, cast

from sqlalchemy import ColumnElement, func, select
from sqlalchemy.orm import Session, selectinload

from app.publications.listing import EAGER_LOAD_OPTIONS
from app.publications.models import ConflictStatus, MetadataConflict, Publication

DEFAULT_CONFLICT_PAGE_SIZE = 25
MAX_CONFLICT_PAGE_SIZE = 200

#: The columns the panel can order by, matching the frontend's
#: ``ConflictSortKey``. ``publication`` orders by the owning publication's
#: title, the heading each card shows.
ConflictSortKey = Literal["publication", "field", "source", "created"]
SortDirection = Literal["asc", "desc"]


@dataclass(frozen=True)
class ConflictFilters:
    """The narrowing a caller asked for. Every field is optional."""

    search: str | None = None
    source: str | None = None
    field: str | None = None


@dataclass(frozen=True)
class ConflictPage:
    """One page of a project's open metadata conflicts, plus the aggregates the
    client used to derive from holding the whole list.

    ``total`` counts the conflicts matching the request's filters;
    ``project_total``, ``source_counts`` and ``field_names`` ignore them and
    describe the project as a whole -- the source/field filter dropdowns, and
    the "Resolve via Provider" hint that needs the project-wide merge-conflict
    count rather than just this page's.
    """

    items: list[MetadataConflict]
    total: int
    project_total: int
    page: int
    page_size: int
    page_count: int
    has_more: bool
    source_counts: dict[str, int]
    field_names: list[str]


def _search_clause(term: str) -> ColumnElement[bool]:
    # A user typing "50%" or "a_b" is searching for those characters, not
    # writing a LIKE pattern.
    escaped = term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    haystack: Any = (
        func.coalesce(Publication.title, "")
        + " "
        + func.coalesce(MetadataConflict.field_name, "")
        + " "
        + func.coalesce(MetadataConflict.current_value, "")
        + " "
        + func.coalesce(MetadataConflict.proposed_value, "")
    )
    return cast(ColumnElement[bool], haystack.ilike(f"%{escaped}%", escape="\\"))


def _project_clauses(project_id: str) -> list[ColumnElement[bool]]:
    """The conflicts a project's panel can ever show: open, and belonging to an
    active publication in this project."""
    return [
        Publication.project_id == project_id,
        MetadataConflict.status == ConflictStatus.OPEN,
    ]


def _filter_clauses(
    project_id: str, filters: ConflictFilters
) -> list[ColumnElement[bool]]:
    clauses = _project_clauses(project_id)
    if filters.source:
        clauses.append(MetadataConflict.source_name == filters.source)
    if filters.field:
        clauses.append(MetadataConflict.field_name == filters.field)
    search = (filters.search or "").strip()
    if search:
        clauses.append(_search_clause(search))
    return clauses


def _sort_expression(key: str) -> Any:
    if key == "publication":
        return func.lower(func.coalesce(Publication.title, ""))
    if key == "field":
        return func.lower(MetadataConflict.field_name)
    if key == "source":
        return func.lower(MetadataConflict.source_name)
    return MetadataConflict.created_at


def _order_by(sort: str, direction: str) -> list[Any]:
    """A *total* order, so consecutive pages cannot overlap or skip rows.

    ``field`` and ``source`` are far from unique -- a bulk merge produces many
    conflicts sharing a source, an enrichment sweep many sharing a field -- so
    without tie-breakers the database is free to return ties in a different
    order on page 2 than on page 1, silently dropping and repeating conflicts.
    ``created_at`` then ``id`` settles every tie deterministically.
    """
    chosen = _sort_expression(sort)
    primary = chosen.desc() if direction == "desc" else chosen.asc()
    return [
        primary,
        MetadataConflict.created_at.desc(),
        MetadataConflict.id.asc(),
    ]


def _count(db: Session, clauses: list[ColumnElement[bool]]) -> int:
    return int(
        db.scalar(
            select(func.count())
            .select_from(MetadataConflict)
            .join(Publication)
            .where(*clauses)
        )
        or 0
    )


def conflicts_page(
    db: Session,
    project_id: str,
    *,
    filters: ConflictFilters | None = None,
    sort: str = "created",
    direction: str = "desc",
    page: int = 1,
    page_size: int = DEFAULT_CONFLICT_PAGE_SIZE,
) -> ConflictPage:
    """One page of ``project_id``'s open metadata conflicts, newest first by
    default."""
    filters = filters or ConflictFilters()
    page_size = max(1, min(page_size, MAX_CONFLICT_PAGE_SIZE))
    page = max(1, page)
    if sort not in ("publication", "field", "source", "created"):
        sort = "created"
    if direction not in ("asc", "desc"):
        direction = "desc"

    clauses = _filter_clauses(project_id, filters)
    unfiltered = _project_clauses(project_id)

    total = _count(db, clauses)
    project_total = _count(db, unfiltered)

    source_counts: dict[str, int] = {}
    for source_name, count in db.execute(
        select(MetadataConflict.source_name, func.count())
        .join(Publication)
        .where(*unfiltered)
        .group_by(MetadataConflict.source_name)
    ).all():
        source_counts[str(source_name)] = int(count)

    field_names = [
        str(name)
        for name in db.scalars(
            select(MetadataConflict.field_name)
            .join(Publication)
            .where(*unfiltered)
            .group_by(MetadataConflict.field_name)
            .order_by(MetadataConflict.field_name)
        )
    ]

    items = list(
        db.scalars(
            select(MetadataConflict)
            .join(Publication)
            .options(selectinload(MetadataConflict.publication).options(*EAGER_LOAD_OPTIONS))
            .where(*clauses)
            .order_by(*_order_by(sort, direction))
            .limit(page_size)
            .offset((page - 1) * page_size)
        )
    )
    page_count = max(1, -(-total // page_size))
    return ConflictPage(
        items=items,
        total=total,
        project_total=project_total,
        page=page,
        page_size=page_size,
        page_count=page_count,
        has_more=(page - 1) * page_size + len(items) < total,
        source_counts=source_counts,
        field_names=field_names,
    )


__all__ = [
    "DEFAULT_CONFLICT_PAGE_SIZE",
    "MAX_CONFLICT_PAGE_SIZE",
    "ConflictFilters",
    "ConflictPage",
    "ConflictSortKey",
    "SortDirection",
    "conflicts_page",
]
