"""Filtering, sorting and paging a project's resolved duplicate decisions.

The Duplicate Review Decisions page used to fetch every ``DuplicateCandidate``
in the project -- including every still-unresolved one -- with both
publications joined, and filtered/sorted the result in the browser. A large
import routinely leaves hundreds or thousands of candidates behind, most of
them unresolved and irrelevant to a page whose whole point is reviewing past
decisions.

Built like ``app.publications.conflict_listing`` (the metadata-conflicts
panel) and ``app.jobs.service``: offset pagination, a total order with an
``id`` tie-breaker so consecutive pages can't overlap or skip, a sort
allowlist with a safe fallback, and a project-wide ``resolved_total`` computed
independently of the active filters so the page can tell "no decisions yet"
apart from "no decisions match your filters".
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal, cast

from sqlalchemy import ColumnElement, func, select
from sqlalchemy.orm import Session, aliased, joinedload

from app.accounts.models import User
from app.deduplication.models import DuplicateCandidate
from app.publications.models import Publication

DEFAULT_CANDIDATE_PAGE_SIZE = 25
MAX_CANDIDATE_PAGE_SIZE = 200

#: Matching the frontend's `SortKey` on the decisions page.
CandidateSortKey = Literal["pair", "decision", "resolvedBy", "resolvedAt"]
SortDirection = Literal["asc", "desc"]

_SORT_KEYS = {"pair", "decision", "resolvedBy", "resolvedAt"}
_RESOLVED_STATUSES = {"merged", "not_duplicate"}


@dataclass(frozen=True)
class CandidateFilters:
    """The narrowing a caller asked for. Every field is optional."""

    search: str | None = None
    #: "merged" | "not_duplicate", or None for both.
    status: str | None = None


@dataclass(frozen=True)
class CandidatePage:
    """One page of a project's resolved duplicate decisions.

    ``total`` counts decisions matching the request's filters; ``resolved_total``
    ignores them and counts every resolved candidate in the project, so the
    page can distinguish "nothing resolved yet" from "nothing matches your
    filters".
    """

    items: list[DuplicateCandidate]
    total: int
    resolved_total: int
    page: int
    page_size: int
    page_count: int
    has_more: bool


def _search_clause(
    pub_a: type[Publication], pub_b: type[Publication], resolved_by: type[User], term: str
) -> ColumnElement[bool]:
    # A user typing "50%" or "a_b" is searching for those characters, not
    # writing a LIKE pattern.
    escaped = term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    haystack: Any = (
        func.coalesce(pub_a.title, "")
        + " "
        + func.coalesce(pub_a.authors, "")
        + " "
        + func.coalesce(pub_b.title, "")
        + " "
        + func.coalesce(pub_b.authors, "")
        + " "
        + func.coalesce(resolved_by.display_name, "")
        + " "
        + func.coalesce(DuplicateCandidate.resolution_note, "")
    )
    return cast(ColumnElement[bool], haystack.ilike(f"%{escaped}%", escape="\\"))


def _resolved_clauses(project_id: str) -> list[ColumnElement[bool]]:
    """The candidates a decisions page can ever show: resolved (merged or
    marked not-a-duplicate) candidates belonging to this project."""
    return [
        DuplicateCandidate.project_id == project_id,
        DuplicateCandidate.status != "unresolved",
    ]


def _filter_clauses(
    project_id: str,
    filters: CandidateFilters,
    pub_a: type[Publication],
    pub_b: type[Publication],
    resolved_by: type[User],
) -> list[ColumnElement[bool]]:
    clauses = _resolved_clauses(project_id)
    if filters.status in _RESOLVED_STATUSES:
        clauses.append(DuplicateCandidate.status == filters.status)
    search = (filters.search or "").strip()
    if search:
        clauses.append(_search_clause(pub_a, pub_b, resolved_by, search))
    return clauses


def _sort_expression(
    key: str, pub_a: type[Publication], resolved_by: type[User]
) -> Any:
    if key == "pair":
        return func.lower(func.coalesce(pub_a.title, ""))
    if key == "decision":
        return DuplicateCandidate.status
    if key == "resolvedBy":
        return func.lower(func.coalesce(resolved_by.display_name, ""))
    return DuplicateCandidate.updated_at


def _order_by(
    sort: str, direction: str, pub_a: type[Publication], resolved_by: type[User]
) -> list[Any]:
    """A *total* order, so consecutive pages cannot overlap or skip rows.

    ``decision`` only has two values and ``pair``/``resolvedBy`` are far from
    unique, so without tie-breakers the database is free to return ties in a
    different order on page 2 than on page 1. ``updated_at`` then ``id``
    settles every tie deterministically.
    """
    chosen = _sort_expression(sort, pub_a, resolved_by)
    primary = chosen.desc() if direction == "desc" else chosen.asc()
    return [
        primary,
        DuplicateCandidate.updated_at.desc(),
        DuplicateCandidate.id.asc(),
    ]


def _count(
    db: Session,
    clauses: list[ColumnElement[bool]],
    pub_a: type[Publication],
    pub_b: type[Publication],
    resolved_by: type[User],
) -> int:
    return int(
        db.scalar(
            select(func.count())
            .select_from(DuplicateCandidate)
            .join(pub_a, DuplicateCandidate.publication_a_id == pub_a.id)
            .join(pub_b, DuplicateCandidate.publication_b_id == pub_b.id)
            .outerjoin(resolved_by, DuplicateCandidate.resolved_by_id == resolved_by.id)
            .where(*clauses)
        )
        or 0
    )


def candidates_page(
    db: Session,
    project_id: str,
    *,
    filters: CandidateFilters | None = None,
    sort: str = "resolvedAt",
    direction: str = "desc",
    page: int = 1,
    page_size: int = DEFAULT_CANDIDATE_PAGE_SIZE,
) -> CandidatePage:
    """One page of ``project_id``'s resolved duplicate decisions, most
    recently resolved first by default."""
    filters = filters or CandidateFilters()
    page_size = max(1, min(page_size, MAX_CANDIDATE_PAGE_SIZE))
    page = max(1, page)
    if sort not in _SORT_KEYS:
        sort = "resolvedAt"
    if direction not in ("asc", "desc"):
        direction = "desc"

    pub_a = aliased(Publication)
    pub_b = aliased(Publication)
    resolved_by = aliased(User)

    clauses = _filter_clauses(project_id, filters, pub_a, pub_b, resolved_by)
    unfiltered = _resolved_clauses(project_id)

    total = _count(db, clauses, pub_a, pub_b, resolved_by)
    resolved_total = _count(db, unfiltered, pub_a, pub_b, resolved_by)

    items = list(
        db.scalars(
            select(DuplicateCandidate)
            .join(pub_a, DuplicateCandidate.publication_a_id == pub_a.id)
            .join(pub_b, DuplicateCandidate.publication_b_id == pub_b.id)
            .outerjoin(resolved_by, DuplicateCandidate.resolved_by_id == resolved_by.id)
            .options(
                joinedload(DuplicateCandidate.publication_a),
                joinedload(DuplicateCandidate.publication_b),
                joinedload(DuplicateCandidate.resolved_by),
            )
            .where(*clauses)
            .order_by(*_order_by(sort, direction, pub_a, resolved_by))
            .limit(page_size)
            .offset((page - 1) * page_size)
        )
    )
    page_count = max(1, -(-total // page_size))
    return CandidatePage(
        items=items,
        total=total,
        resolved_total=resolved_total,
        page=page,
        page_size=page_size,
        page_count=page_count,
        has_more=(page - 1) * page_size + len(items) < total,
    )


__all__ = [
    "DEFAULT_CANDIDATE_PAGE_SIZE",
    "MAX_CANDIDATE_PAGE_SIZE",
    "CandidateFilters",
    "CandidatePage",
    "CandidateSortKey",
    "SortDirection",
    "candidates_page",
]
