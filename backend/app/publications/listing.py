"""Filtering, sorting and paging one project's publication list.

The Publications page used to be served as "every active publication in the
project, ordered by title", with search, three filters and six sort keys all
applied in the browser over that full list. A systematic review routinely
carries thousands of records after import and deduplication, so that response
grew without bound: the server eager-loaded documents, final decisions,
extraction slots, final extractions and retrieval state for *every* row on
every visit, and the browser then held and re-sorted the lot.

So narrowing and ordering belong here, over the whole table, with paging the
client can follow.

**Offset, not keyset.** The audit log (``app.audit.query``) pages by cursor
because it is append-only and read newest-first: rows are inserted *ahead* of
what a reader is looking at, which is exactly what breaks an offset. A
publication list is the opposite case. Its ordering is chosen by the reader
from six keys, two of which (``stage``, ``pdf``) are derived, low-cardinality
values with no monotonic anchor a cursor could name, and the set itself is
comparatively stable -- publications arrive in deliberate bulk imports, not
continuously while somebody browses. Offset also gives the UI what it
actually shows: a total, a page count, and the ability to jump.

**Stage ordering lives in SQL, deliberately.** ``stage`` orders by the label
the frontend's ``primaryStage()``
(``frontend/src/features/publications/publicationShared.ts``) shows on each
row, collapsed to a rank. Expressing that as a single CASE lets the database
order and slice a stage-sorted page instead of the server loading a whole
project to sort it in memory. The two definitions must stay in step:
``_stage_rank`` below mirrors ``primaryStage`` branch for branch, in the same
order, and ``tests/test_publication_listing.py`` pins every branch with one
publication per label. Change one, change the other.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal, cast

from sqlalchemy import (
    ColumnElement,
    String,
    and_,
    case,
    func,
    literal,
    select,
)
from sqlalchemy import (
    cast as sql_cast,
)
from sqlalchemy.orm import Session, selectinload

from app.conflicts.models import FinalDecision
from app.extraction.models import ExtractionWorkItem, FinalExtraction
from app.fulltext.models import (
    FullTextRetrieval,
    PublicationDocument,
    RetrievalStatus,
)
from app.projects.models import ScreeningStage
from app.publications.models import Publication
from app.screening.models import ScreeningOutcome

DEFAULT_PAGE_SIZE = 50
MAX_PAGE_SIZE = 200

#: The six columns the list can be ordered by, matching the frontend's
#: ``PublicationSortKey``.
PublicationSortKey = Literal["title", "authors", "year", "source", "stage", "pdf"]
SortDirection = Literal["asc", "desc"]
#: A screening-stage filter. "pending" means the stage has produced no valid
#: final decision yet -- the same collapsing the UI does.
ScreeningFilterValue = Literal[
    "pending", "include", "exclude", "uncertain", "duplicate"
]
PdfStatusFilterValue = Literal["available", "unavailable"]

#: Stands in for a missing publication year so that ordering by year puts
#: unknown years first ascending and last descending, exactly as the browser's
#: ``-Infinity`` did. Expressed as a value rather than a NULLS FIRST/LAST
#: clause so the same statement works on SQLite and PostgreSQL alike.
_UNKNOWN_YEAR = -2147483648

#: Everything a publication row needs to render, loaded in a fixed number of
#: queries regardless of page size. ``extraction_status``, ``screening_status``
#: and ``full_text`` are model properties over exactly these relationships (see
#: ``app.publications.models``), so nothing here costs a per-row query.
EAGER_LOAD_OPTIONS = (
    selectinload(Publication.documents).joinedload(PublicationDocument.uploaded_by),
    selectinload(Publication.final_decisions),
    selectinload(Publication.extraction_work_items),
    selectinload(Publication.final_extractions),
    selectinload(Publication.full_text_retrieval),
)


@dataclass(frozen=True)
class PublicationFilters:
    """The narrowing a caller asked for. Every field is optional."""

    search: str | None = None
    title_abstract: str | None = None
    full_text: str | None = None
    pdf_status: str | None = None


@dataclass(frozen=True)
class PublicationPage:
    items: list[Publication]
    total: int
    project_total: int
    missing_pdf_count: int
    page: int
    page_size: int
    page_count: int
    has_more: bool


def _final_outcome(stage: ScreeningStage) -> Any:
    """This publication's current valid final decision at ``stage``, or NULL.

    Mirrors ``Publication.screening_status``, which reads the one valid
    ``FinalDecision`` per stage (a partial unique index guarantees at most
    one).
    """
    return (
        select(FinalDecision.outcome)
        .where(
            FinalDecision.publication_id == Publication.id,
            FinalDecision.stage == stage,
            FinalDecision.is_valid.is_(True),
        )
        .correlate(Publication)
        .limit(1)
        .scalar_subquery()
    )


def _has_active_pdf() -> ColumnElement[bool]:
    return (
        select(literal(1))
        .where(
            PublicationDocument.publication_id == Publication.id,
            PublicationDocument.is_active.is_(True),
        )
        .correlate(Publication)
        .exists()
    )


def _extraction_in_flight() -> ColumnElement[bool]:
    """Extraction has started and has not reached an authoritative result.

    The SQL counterpart of the frontend's ``isExtractionInFlight``. Every
    value of ``PublicationExtractionStatus`` except ``not_started`` (no slots
    at all) and ``completed`` (a current valid ``FinalExtraction`` exists) is
    in flight, so the derivation collapses to exactly those two absences --
    see ``app.extraction.status.derive_publication_extraction_status``.
    """
    has_slot = (
        select(literal(1))
        .where(ExtractionWorkItem.publication_id == Publication.id)
        .correlate(Publication)
        .exists()
    )
    has_final = (
        select(literal(1))
        .where(
            FinalExtraction.publication_id == Publication.id,
            FinalExtraction.is_valid.is_(True),
        )
        .correlate(Publication)
        .exists()
    )
    return and_(has_slot, ~has_final)


def _retrieval_status() -> Any:
    return (
        select(FullTextRetrieval.status)
        .where(FullTextRetrieval.publication_id == Publication.id)
        .correlate(Publication)
        .limit(1)
        .scalar_subquery()
    )


def _stage_rank() -> ColumnElement[int]:
    """The workflow rank of ``primaryStage(publication).label``, in SQL.

    Branch order is load-bearing and matches ``primaryStage`` exactly:

    ==================================  =====================  ====
    condition                           label                  rank
    ==================================  =====================  ====
    title/abstract excluded             Excluded                  7
    title/abstract uncertain            Uncertain                 5
    title/abstract duplicate            Duplicate                 6
    no title/abstract decision          New                       0
    full text excluded                  Excluded                  7
    full text uncertain                 Uncertain                 5
    full text duplicate                 Duplicate                 6
    full text included, extracting      Extraction                3
    full text included                  Included                  4
    retrieval failed                    Not found/Inaccessible    8
    a PDF is attached                   Full-Text                 2
    otherwise                           Screened                  1
    ==================================  =====================  ====

    A comparison against NULL yields NULL, which a CASE treats as not
    matching, so a stage with no decision simply falls through to the next
    branch -- the same thing the frontend's ``===`` against ``undefined``
    does.
    """
    title_abstract = _final_outcome(ScreeningStage.TITLE_ABSTRACT)
    full_text = _final_outcome(ScreeningStage.FULL_TEXT)
    return case(
        (title_abstract == ScreeningOutcome.EXCLUDE, 7),
        (title_abstract == ScreeningOutcome.UNCERTAIN, 5),
        (title_abstract == ScreeningOutcome.DUPLICATE, 6),
        (title_abstract.is_(None), 0),
        (full_text == ScreeningOutcome.EXCLUDE, 7),
        (full_text == ScreeningOutcome.UNCERTAIN, 5),
        (full_text == ScreeningOutcome.DUPLICATE, 6),
        (
            and_(full_text == ScreeningOutcome.INCLUDE, _extraction_in_flight()),
            3,
        ),
        (full_text == ScreeningOutcome.INCLUDE, 4),
        (
            _retrieval_status().in_(
                [RetrievalStatus.NOT_FOUND, RetrievalStatus.INACCESSIBLE]
            ),
            8,
        ),
        (_has_active_pdf(), 2),
        else_=1,
    )


def _searchable_metadata() -> Any:
    """Every bibliographic field joined into one haystack.

    The same concatenation the browser built before searching it, so a term
    still matches whichever field happens to carry it (and, as before, can
    span two adjacent fields).
    """
    columns: list[Any] = [
        Publication.title,
        Publication.authors,
        Publication.abstract,
        sql_cast(Publication.publication_year, String),
        Publication.venue,
        Publication.publication_type,
        Publication.doi,
        Publication.publisher_url,
        Publication.keywords,
        Publication.isbn,
        Publication.issn,
        Publication.pubmed_id,
        Publication.arxiv_id,
    ]
    haystack: Any = func.coalesce(columns[0], "")
    for column in columns[1:]:
        haystack = haystack + " " + func.coalesce(column, "")
    return haystack


def _search_clause(term: str) -> ColumnElement[bool]:
    # A user typing "50%" or "a_b" is searching for those characters, not
    # writing a LIKE pattern.
    escaped = term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return cast(
        ColumnElement[bool],
        _searchable_metadata().ilike(f"%{escaped}%", escape="\\"),
    )


def _screening_clause(
    stage: ScreeningStage, value: str
) -> ColumnElement[bool]:
    outcome = _final_outcome(stage)
    if value == "pending":
        return cast(ColumnElement[bool], outcome.is_(None))
    return cast(ColumnElement[bool], outcome == ScreeningOutcome(value))


def project_clauses(project_id: str) -> list[ColumnElement[bool]]:
    """The publications a project's list can ever show."""
    return [
        Publication.project_id == project_id,
        Publication.is_active.is_(True),
    ]


def _filter_clauses(
    project_id: str, filters: PublicationFilters
) -> list[ColumnElement[bool]]:
    clauses = project_clauses(project_id)
    if filters.title_abstract:
        clauses.append(
            _screening_clause(ScreeningStage.TITLE_ABSTRACT, filters.title_abstract)
        )
    if filters.full_text:
        clauses.append(_screening_clause(ScreeningStage.FULL_TEXT, filters.full_text))
    if filters.pdf_status == "available":
        clauses.append(_has_active_pdf())
    elif filters.pdf_status == "unavailable":
        clauses.append(~_has_active_pdf())
    search = (filters.search or "").strip()
    if search:
        clauses.append(_search_clause(search))
    return clauses


def _sort_expression(key: str) -> Any:
    if key == "authors":
        return func.lower(func.coalesce(Publication.authors, ""))
    if key == "year":
        return func.coalesce(Publication.publication_year, _UNKNOWN_YEAR)
    if key == "source":
        return func.lower(func.coalesce(Publication.venue, ""))
    if key == "stage":
        return _stage_rank()
    if key == "pdf":
        return case((_has_active_pdf(), 1), else_=0)
    return func.lower(func.coalesce(Publication.title, ""))


def _order_by(sort: str, direction: str) -> list[Any]:
    """A *total* order, so consecutive pages cannot overlap or skip rows.

    Four of the six sort keys are far from unique -- ``stage`` and ``pdf``
    have at most ten and two distinct values -- so without tie-breakers the
    database is free to return ties in a different order for page 2 than it
    did for page 1, silently dropping and repeating publications. Title then
    id settles every tie deterministically.
    """
    chosen = _sort_expression(sort)
    primary = chosen.desc() if direction == "desc" else chosen.asc()
    return [
        primary,
        func.lower(func.coalesce(Publication.title, "")).asc(),
        Publication.id.asc(),
    ]


def _count(db: Session, clauses: list[ColumnElement[bool]]) -> int:
    return int(
        db.scalar(select(func.count()).select_from(Publication).where(*clauses)) or 0
    )


def publications_page(
    db: Session,
    project_id: str,
    *,
    filters: PublicationFilters | None = None,
    sort: str = "title",
    direction: str = "asc",
    page: int = 1,
    page_size: int = DEFAULT_PAGE_SIZE,
) -> PublicationPage:
    """One page of a project's publications.

    Alongside the page itself: ``total`` counts everything matching
    ``filters`` (so the UI can say how much it is showing rather than
    implying the page is all there is), while ``project_total`` and
    ``missing_pdf_count`` describe the whole project regardless of the
    filters -- both were previously read off the full list the client held.
    """
    filters = filters or PublicationFilters()
    page_size = max(1, min(page_size, MAX_PAGE_SIZE))
    page = max(1, page)

    clauses = _filter_clauses(project_id, filters)
    unfiltered = project_clauses(project_id)

    total = _count(db, clauses)
    project_total = _count(db, unfiltered)
    missing_pdf_count = _count(db, [*unfiltered, ~_has_active_pdf()])

    items = list(
        db.scalars(
            select(Publication)
            .options(*EAGER_LOAD_OPTIONS)
            .where(*clauses)
            .order_by(*_order_by(sort, direction))
            .limit(page_size)
            .offset((page - 1) * page_size)
        )
    )
    page_count = max(1, -(-total // page_size))
    return PublicationPage(
        items=items,
        total=total,
        project_total=project_total,
        missing_pdf_count=missing_pdf_count,
        page=page,
        page_size=page_size,
        page_count=page_count,
        has_more=(page - 1) * page_size + len(items) < total,
    )


def matching_publication_ids(
    db: Session,
    project_id: str,
    *,
    filters: PublicationFilters | None = None,
    sort: str = "title",
    direction: str = "asc",
) -> list[str]:
    """Every publication id matching ``filters``, in the same order as the
    pages -- and nothing else.

    Bulk actions (enrich, export, delete) act on a set of ids, not on a page,
    so "select everything matching my filters" has to stay reachable now that
    no client holds the full list. Ids only: a project's whole id set is a
    few hundred kilobytes at worst, where the hydrated rows it stands for are
    what this module exists to stop sending.
    """
    return list(
        db.scalars(
            select(Publication.id)
            .where(*_filter_clauses(project_id, filters or PublicationFilters()))
            .order_by(*_order_by(sort, direction))
        )
    )


__all__ = [
    "DEFAULT_PAGE_SIZE",
    "EAGER_LOAD_OPTIONS",
    "MAX_PAGE_SIZE",
    "PdfStatusFilterValue",
    "PublicationFilters",
    "PublicationPage",
    "PublicationSortKey",
    "ScreeningFilterValue",
    "SortDirection",
    "matching_publication_ids",
    "publications_page",
]
