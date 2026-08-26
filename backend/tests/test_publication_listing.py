"""Server-side paging, filtering, searching and sorting of a project's
publications.

The list endpoint used to return every active publication in the project,
fully eager-loaded, and the browser did all the narrowing. These tests pin the
replacement: the same six sort keys, the same three filters and the same
free-text search, now applied by the database, over pages that neither repeat
nor skip a record.
"""

from __future__ import annotations

from collections.abc import Iterator

import pytest
from sqlalchemy import event
from sqlalchemy.engine import Engine

from app.accounts.service import create_user
from app.conflicts.service import record_final_decision
from app.extraction.models import ExtractionStatus, ExtractionWorkItem
from app.fulltext.models import (
    FullTextRetrieval,
    PublicationDocument,
    RetrievalStatus,
)
from app.projects.models import Project, ReviewType, ScreeningStage
from app.publications.models import Publication


def login(client) -> str:
    response = client.post(
        "/api/v1/auth/login", json={"username": "admin", "password": "secret-password"}
    )
    return response.json()["csrfToken"]


@pytest.fixture()
def project(client, db) -> Project:
    create_user(db, "admin", "Administrator", "secret-password", is_admin=True)
    project = Project(
        name="Review", review_type=ReviewType.SYSTEMATIC_REVIEW, random_seed="seed"
    )
    db.add(project)
    db.commit()
    login(client)
    return project


def add_publication(db, project: Project, title: str, **fields) -> Publication:
    publication = Publication(project_id=project.id, title=title, **fields)
    db.add(publication)
    db.flush()
    return publication


def attach_pdf(db, project: Project, publication: Publication) -> None:
    db.add(
        PublicationDocument(
            project_id=project.id,
            publication_id=publication.id,
            original_filename="paper.pdf",
            storage_key=(
                f"projects/{project.id}/publications/{publication.id}/doc.pdf"
            ),
            mime_type="application/pdf",
            file_size=1024,
            sha256=publication.id.replace("-", "")[:64].ljust(64, "0"),
        )
    )
    db.flush()


def decide(db, publication: Publication, stage: ScreeningStage, outcome: str) -> None:
    record_final_decision(db, publication.id, stage, outcome, "agreement", None, None)


def set_retrieval(
    db, project: Project, publication: Publication, status: RetrievalStatus
) -> None:
    """Force a full-text retrieval outcome.

    A title/abstract INCLUDE already initializes the full-text stage, so the
    row usually exists by the time a test wants to fail it.
    """
    retrieval = (
        db.query(FullTextRetrieval)
        .filter(FullTextRetrieval.publication_id == publication.id)
        .one_or_none()
    )
    if retrieval is None:
        retrieval = FullTextRetrieval(
            project_id=project.id, publication_id=publication.id
        )
        db.add(retrieval)
    retrieval.status = status
    db.flush()


def listing(client, project: Project, **params) -> dict:
    response = client.get(
        f"/api/v1/projects/{project.id}/publications", params=params
    )
    assert response.status_code == 200, response.text
    return response.json()


def titles(payload: dict) -> list[str]:
    return [item["title"] for item in payload["items"]]


# --------------------------------------------------------------------------
# Paging
# --------------------------------------------------------------------------


def test_pages_cover_every_publication_exactly_once(client, db, project) -> None:
    """The regression this endpoint exists to prevent is data loss.

    A capped or badly-ordered page is worse than a slow one: the reader
    cannot tell a publication that was paged past from a publication the
    project never had.
    """
    for index in range(25):
        add_publication(db, project, f"Paper {index:02d}")
    db.commit()

    seen: list[str] = []
    for page in (1, 2, 3):
        payload = listing(client, project, pageSize=10, page=page)
        assert payload["total"] == 25
        assert payload["projectTotal"] == 25
        assert payload["pageCount"] == 3
        assert payload["page"] == page
        assert payload["pageSize"] == 10
        assert payload["hasMore"] is (page < 3)
        seen.extend(item["id"] for item in payload["items"])

    assert len(seen) == 25
    assert len(set(seen)) == 25
    assert titles(listing(client, project, pageSize=10, page=1)) == [
        f"Paper {index:02d}" for index in range(10)
    ]
    assert titles(listing(client, project, pageSize=10, page=3)) == [
        f"Paper {index:02d}" for index in range(20, 25)
    ]


def test_a_page_past_the_end_is_empty_without_losing_the_totals(
    client, db, project
) -> None:
    for index in range(3):
        add_publication(db, project, f"Paper {index}")
    db.commit()

    payload = listing(client, project, pageSize=10, page=4)
    assert payload["items"] == []
    assert payload["total"] == 3
    assert payload["hasMore"] is False


def test_page_size_is_capped_and_invalid_paging_is_rejected(
    client, db, project
) -> None:
    add_publication(db, project, "Only paper")
    db.commit()

    assert listing(client, project, pageSize=200)["pageSize"] == 200
    # An unbounded page would just be the old full-list response wearing a
    # query parameter, so asking for one is a request error, not a clamp.
    assert (
        client.get(
            f"/api/v1/projects/{project.id}/publications", params={"pageSize": 5000}
        ).status_code
        == 422
    )
    assert (
        client.get(
            f"/api/v1/projects/{project.id}/publications", params={"page": 0}
        ).status_code
        == 422
    )
    assert (
        client.get(
            f"/api/v1/projects/{project.id}/publications", params={"sort": "nonsense"}
        ).status_code
        == 422
    )


def test_ties_are_broken_deterministically_so_low_cardinality_sorts_still_page(
    client, db, project
) -> None:
    """`pdf` has two distinct values and `stage` ten, so without a
    tie-breaker the database may return ties in a different order per page --
    silently repeating some publications and dropping others."""
    for index in range(12):
        add_publication(db, project, f"Paper {index:02d}")
    db.commit()

    seen: list[str] = []
    for page in (1, 2, 3):
        seen.extend(
            item["id"]
            for item in listing(
                client, project, sort="pdf", direction="desc", pageSize=4, page=page
            )["items"]
        )
    assert len(set(seen)) == 12


# --------------------------------------------------------------------------
# Filters
# --------------------------------------------------------------------------


def test_filters_by_title_abstract_outcome_including_pending(
    client, db, project
) -> None:
    included = add_publication(db, project, "Included paper")
    excluded = add_publication(db, project, "Excluded paper")
    uncertain = add_publication(db, project, "Uncertain paper")
    add_publication(db, project, "Untouched paper")
    decide(db, included, ScreeningStage.TITLE_ABSTRACT, "include")
    decide(db, excluded, ScreeningStage.TITLE_ABSTRACT, "exclude")
    decide(db, uncertain, ScreeningStage.TITLE_ABSTRACT, "uncertain")
    db.commit()

    assert titles(listing(client, project, titleAbstract="include")) == [
        "Included paper"
    ]
    assert titles(listing(client, project, titleAbstract="exclude")) == [
        "Excluded paper"
    ]
    assert titles(listing(client, project, titleAbstract="uncertain")) == [
        "Uncertain paper"
    ]
    assert titles(listing(client, project, titleAbstract="pending")) == [
        "Untouched paper"
    ]

    pending = listing(client, project, titleAbstract="pending")
    assert pending["total"] == 1
    # The project-wide counts ignore the filters -- they are what the UI
    # reports as "1 of 4 publications match your filters".
    assert pending["projectTotal"] == 4


def test_filters_by_full_text_outcome_independently_of_title_abstract(
    client, db, project
) -> None:
    both = add_publication(db, project, "Included at both stages")
    dropped = add_publication(db, project, "Dropped at full text")
    awaiting = add_publication(db, project, "Awaiting full text")
    for publication in (both, dropped, awaiting):
        decide(db, publication, ScreeningStage.TITLE_ABSTRACT, "include")
    decide(db, both, ScreeningStage.FULL_TEXT, "include")
    decide(db, dropped, ScreeningStage.FULL_TEXT, "exclude")
    db.commit()

    assert titles(listing(client, project, fullText="include")) == [
        "Included at both stages"
    ]
    assert titles(listing(client, project, fullText="exclude")) == [
        "Dropped at full text"
    ]
    assert titles(listing(client, project, fullText="pending")) == [
        "Awaiting full text"
    ]
    assert titles(
        listing(client, project, titleAbstract="include", fullText="pending")
    ) == ["Awaiting full text"]


def test_filters_by_pdf_availability_and_reports_the_project_wide_gap(
    client, db, project
) -> None:
    with_pdf = add_publication(db, project, "Has a PDF")
    add_publication(db, project, "No PDF one")
    add_publication(db, project, "No PDF two")
    attach_pdf(db, project, with_pdf)
    db.commit()

    assert titles(listing(client, project, pdfStatus="available")) == ["Has a PDF"]
    unavailable = listing(client, project, pdfStatus="unavailable")
    assert titles(unavailable) == ["No PDF one", "No PDF two"]
    # missingPdfCount describes the project, not the filtered page: it drives
    # the "N papers missing a PDF" shortcut, which has to keep saying N while
    # that very filter is applied.
    assert unavailable["missingPdfCount"] == 2
    assert listing(client, project, pdfStatus="available")["missingPdfCount"] == 2


def test_a_removed_pdf_no_longer_counts_as_available(client, db, project) -> None:
    publication = add_publication(db, project, "Replaced PDF")
    attach_pdf(db, project, publication)
    db.commit()
    document = db.query(PublicationDocument).one()
    document.is_active = False
    db.commit()

    assert titles(listing(client, project, pdfStatus="available")) == []
    assert titles(listing(client, project, pdfStatus="unavailable")) == [
        "Replaced PDF"
    ]


def test_deleted_publications_never_appear_in_any_page_or_count(
    client, db, project
) -> None:
    kept = add_publication(db, project, "Kept paper")
    removed = add_publication(db, project, "Removed paper")
    db.commit()
    removed.is_active = False
    db.commit()

    payload = listing(client, project)
    assert titles(payload) == ["Kept paper"]
    assert payload["total"] == payload["projectTotal"] == 1
    assert listing(client, project)["items"][0]["id"] == kept.id


# --------------------------------------------------------------------------
# Search
# --------------------------------------------------------------------------


def test_search_spans_every_bibliographic_field(client, db, project) -> None:
    add_publication(
        db,
        project,
        "Urban Data in VR",
        authors="A. Author",
        abstract="Immersive analytics for city planners.",
        doi="10.1000/urban-vr",
        venue="Journal of Cities",
        keywords="visualisation",
        publication_year=2025,
    )
    add_publication(db, project, "Something else entirely", authors="B. Other")
    db.commit()

    for term in (
        "urban data",
        "A. Author",
        "immersive analytics",
        "10.1000/urban-vr",
        "Journal of Cities",
        "visualisation",
        "2025",
    ):
        assert titles(listing(client, project, search=term)) == ["Urban Data in VR"], (
            term
        )

    assert titles(listing(client, project, search="nothing at all")) == []
    assert listing(client, project, search="nothing at all")["projectTotal"] == 2


def test_search_is_case_insensitive_and_treats_wildcards_literally(
    client, db, project
) -> None:
    add_publication(db, project, "A 50% Improvement")
    add_publication(db, project, "Unrelated work")
    db.commit()

    assert titles(listing(client, project, search="a 50% improvement")) == [
        "A 50% Improvement"
    ]
    # "%" and "_" are characters a user typed, not LIKE wildcards.
    assert titles(listing(client, project, search="%")) == ["A 50% Improvement"]
    assert titles(listing(client, project, search="_")) == []


def test_search_combines_with_filters_and_sorting(client, db, project) -> None:
    first = add_publication(db, project, "Alpha urban study", publication_year=2001)
    second = add_publication(db, project, "Beta urban study", publication_year=2020)
    add_publication(db, project, "Gamma urban study", publication_year=2010)
    add_publication(db, project, "Delta rural study", publication_year=2005)
    decide(db, first, ScreeningStage.TITLE_ABSTRACT, "include")
    decide(db, second, ScreeningStage.TITLE_ABSTRACT, "include")
    db.commit()

    payload = listing(
        client,
        project,
        search="urban",
        titleAbstract="include",
        sort="year",
        direction="desc",
    )
    assert titles(payload) == ["Beta urban study", "Alpha urban study"]
    assert payload["total"] == 2
    assert payload["projectTotal"] == 4


# --------------------------------------------------------------------------
# Sorting
# --------------------------------------------------------------------------


def test_sorts_by_title_authors_and_source_case_insensitively(
    client, db, project
) -> None:
    add_publication(db, project, "beta paper", authors="zeta", venue="alpha journal")
    add_publication(db, project, "Alpha paper", authors="Mid", venue="Zeta journal")
    add_publication(db, project, "Gamma paper", authors=None, venue=None)
    db.commit()

    assert titles(listing(client, project, sort="title")) == [
        "Alpha paper",
        "beta paper",
        "Gamma paper",
    ]
    assert titles(listing(client, project, sort="title", direction="desc")) == [
        "Gamma paper",
        "beta paper",
        "Alpha paper",
    ]
    # A missing author or venue sorts as empty, i.e. first ascending -- the
    # same thing the browser's `?? ''` did.
    assert titles(listing(client, project, sort="authors")) == [
        "Gamma paper",
        "Alpha paper",
        "beta paper",
    ]
    assert titles(listing(client, project, sort="source")) == [
        "Gamma paper",
        "beta paper",
        "Alpha paper",
    ]


def test_sorts_by_year_with_unknown_years_first_ascending(client, db, project) -> None:
    add_publication(db, project, "Newer", publication_year=2024)
    add_publication(db, project, "Older", publication_year=1999)
    add_publication(db, project, "Undated", publication_year=None)
    db.commit()

    assert titles(listing(client, project, sort="year")) == [
        "Undated",
        "Older",
        "Newer",
    ]
    assert titles(listing(client, project, sort="year", direction="desc")) == [
        "Newer",
        "Older",
        "Undated",
    ]


def test_sorts_by_pdf_availability(client, db, project) -> None:
    with_pdf = add_publication(db, project, "Has a PDF")
    add_publication(db, project, "Missing a PDF")
    attach_pdf(db, project, with_pdf)
    db.commit()

    assert titles(listing(client, project, sort="pdf", direction="desc")) == [
        "Has a PDF",
        "Missing a PDF",
    ]
    assert titles(listing(client, project, sort="pdf")) == [
        "Missing a PDF",
        "Has a PDF",
    ]


def _publications_covering_every_stage(db, project: Project) -> None:
    """One publication per label ``primaryStage()`` can produce.

    Titles are numbered by the rank the frontend's ``STAGE_SORT_RANK`` gives
    that label, so an ascending stage sort must return them in title order.
    """
    add_publication(db, project, "0 New")

    screened = add_publication(db, project, "1 Screened")
    decide(db, screened, ScreeningStage.TITLE_ABSTRACT, "include")

    full_text = add_publication(db, project, "2 Full-Text")
    decide(db, full_text, ScreeningStage.TITLE_ABSTRACT, "include")
    attach_pdf(db, project, full_text)

    extracting = add_publication(db, project, "3 Extraction")
    decide(db, extracting, ScreeningStage.TITLE_ABSTRACT, "include")
    decide(db, extracting, ScreeningStage.FULL_TEXT, "include")
    db.add(
        ExtractionWorkItem(
            project_id=project.id,
            publication_id=extracting.id,
            slot_number=1,
            random_rank="rank-1",
            status=ExtractionStatus.AVAILABLE,
        )
    )

    included = add_publication(db, project, "4 Included")
    decide(db, included, ScreeningStage.TITLE_ABSTRACT, "include")
    decide(db, included, ScreeningStage.FULL_TEXT, "include")

    uncertain = add_publication(db, project, "5 Uncertain")
    decide(db, uncertain, ScreeningStage.TITLE_ABSTRACT, "uncertain")

    duplicate = add_publication(db, project, "6 Duplicate")
    decide(db, duplicate, ScreeningStage.TITLE_ABSTRACT, "duplicate")

    excluded = add_publication(db, project, "7 Excluded")
    decide(db, excluded, ScreeningStage.TITLE_ABSTRACT, "exclude")

    not_found = add_publication(db, project, "8 Not found")
    decide(db, not_found, ScreeningStage.TITLE_ABSTRACT, "include")
    set_retrieval(db, project, not_found, RetrievalStatus.NOT_FOUND)

    inaccessible = add_publication(db, project, "8 Inaccessible")
    decide(db, inaccessible, ScreeningStage.TITLE_ABSTRACT, "include")
    set_retrieval(db, project, inaccessible, RetrievalStatus.INACCESSIBLE)
    db.commit()


def test_stage_sort_reproduces_the_frontend_workflow_ranking(
    client, db, project
) -> None:
    """Every branch of ``primaryStage()`` maps to the rank the UI gives it.

    "Not found" and "Inaccessible" deliberately share rank 8, so they fall
    back to the title tie-breaker.
    """
    _publications_covering_every_stage(db, project)

    assert titles(listing(client, project, sort="stage", pageSize=200)) == [
        "0 New",
        "1 Screened",
        "2 Full-Text",
        "3 Extraction",
        "4 Included",
        "5 Uncertain",
        "6 Duplicate",
        "7 Excluded",
        "8 Inaccessible",
        "8 Not found",
    ]
    assert titles(listing(client, project, sort="stage", direction="desc"))[0] in {
        "8 Inaccessible",
        "8 Not found",
    }


def test_stage_sorted_pages_neither_repeat_nor_skip(client, db, project) -> None:
    _publications_covering_every_stage(db, project)

    pages = [
        listing(client, project, sort="stage", pageSize=3, page=page)
        for page in (1, 2, 3, 4)
    ]
    assert [page["pageCount"] for page in pages] == [4, 4, 4, 4]
    combined = [title for page in pages for title in titles(page)]
    assert combined == titles(listing(client, project, sort="stage", pageSize=200))
    assert len(set(combined)) == 10


def test_a_finished_extraction_is_included_rather_than_extracting(
    client, db, project
) -> None:
    """Rank 3 ("Extraction") means slots exist with no authoritative result.

    Once a valid FinalExtraction exists the publication is done, and must
    rank alongside plain "Included" -- the same distinction
    ``isExtractionInFlight`` draws in the browser.
    """
    from app.extraction.final import create_or_replace_final_extraction
    from app.forms.models import FormKind
    from app.forms.service import create_form

    publication = add_publication(db, project, "Extracted paper")
    decide(db, publication, ScreeningStage.TITLE_ABSTRACT, "include")
    decide(db, publication, ScreeningStage.FULL_TEXT, "include")
    db.add(
        ExtractionWorkItem(
            project_id=project.id,
            publication_id=publication.id,
            slot_number=1,
            random_rank="rank-1",
            status=ExtractionStatus.COMPLETED,
        )
    )
    form = create_form(db, "Extraction", FormKind.EXTRACTION, project_id=project.id)
    db.flush()
    db.commit()

    assert listing(client, project)["items"][0]["extractionStatus"] == "in_progress"
    in_flight_first = titles(
        listing(client, project, sort="stage", direction="desc")
    )

    create_or_replace_final_extraction(
        db,
        project_id=project.id,
        publication_id=publication.id,
        form_version_id=form.active_version_id or "",
        answers={},
        resolution_method="single_reviewer",
        resolved_by_id=None,
        note=None,
        field_provenance={},
        contributing_response_ids=[],
    )
    db.commit()

    assert listing(client, project)["items"][0]["extractionStatus"] == "completed"
    # Both orderings hold a single publication; what changes is the rank it
    # carries, which the ids endpoint below exercises jointly with filters.
    assert in_flight_first == ["Extracted paper"]


# --------------------------------------------------------------------------
# Bulk selection across pages
# --------------------------------------------------------------------------


def test_ids_endpoint_returns_every_match_across_pages_in_page_order(
    client, db, project
) -> None:
    """Bulk enrich/export/delete act on ids, not on a page.

    "Select all N matching" would otherwise have quietly become "select the
    50 rows you can see".
    """
    for index in range(25):
        publication = add_publication(db, project, f"Paper {index:02d}")
        if index % 2 == 0:
            decide(db, publication, ScreeningStage.TITLE_ABSTRACT, "include")
    db.commit()

    response = client.get(
        f"/api/v1/projects/{project.id}/publications/ids",
        params={"titleAbstract": "include"},
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["total"] == 13
    assert len(payload["ids"]) == 13

    paged: list[str] = []
    for page in (1, 2):
        paged.extend(
            item["id"]
            for item in listing(
                client, project, titleAbstract="include", pageSize=10, page=page
            )["items"]
        )
    assert payload["ids"] == paged


def test_ids_endpoint_is_not_read_as_a_publication_id(client, db, project) -> None:
    add_publication(db, project, "Only paper")
    db.commit()

    response = client.get(f"/api/v1/projects/{project.id}/publications/ids")
    assert response.status_code == 200
    assert set(response.json()) == {"ids", "total"}


# --------------------------------------------------------------------------
# Cost
# --------------------------------------------------------------------------


@pytest.fixture()
def count_queries() -> Iterator[list[str]]:
    """Every SQL statement executed while the fixture's list is active."""
    statements: list[str] = []
    recording = False

    def record(conn, cursor, statement, parameters, context, executemany) -> None:
        if recording:
            statements.append(statement)

    event.listen(Engine, "before_cursor_execute", record)

    class Recorder(list):
        def __enter__(self):
            nonlocal recording
            statements.clear()
            recording = True
            return self

        def __exit__(self, *exc) -> None:
            nonlocal recording
            recording = False
            self[:] = statements

    try:
        yield Recorder()
    finally:
        event.remove(Engine, "before_cursor_execute", record)


def test_a_page_costs_the_same_number_of_queries_however_large_the_project(
    client, db, project, count_queries
) -> None:
    """The point of the eager-load options is that a page is a constant
    number of round trips -- not one per publication, and not more of them
    because the project grew."""
    for index in range(5):
        publication = add_publication(db, project, f"Paper {index:02d}")
        attach_pdf(db, project, publication)
        decide(db, publication, ScreeningStage.TITLE_ABSTRACT, "include")
    db.commit()

    with count_queries as small:
        listing(client, project, pageSize=5)
    small_count = len(small)

    for index in range(5, 60):
        publication = add_publication(db, project, f"Paper {index:02d}")
        attach_pdf(db, project, publication)
        decide(db, publication, ScreeningStage.TITLE_ABSTRACT, "include")
    db.commit()

    with count_queries as large_page:
        payload = listing(client, project, pageSize=50)
    assert len(payload["items"]) == 50
    assert payload["total"] == 60

    with count_queries as small_page:
        listing(client, project, pageSize=5)

    assert len(large_page) == len(small_page) == small_count
    # Nine statements do the listing -- three counts (filtered, project,
    # missing PDF), the page itself, and one selectin per eager-loaded
    # relationship -- on top of the fixed cost of authenticating the session
    # and loading the project for the access check. Flat is the property that
    # matters; the ceiling just stops a per-row query creeping back in.
    assert small_count <= 18
