"""Server-side paging, filtering and sorting of a project's open metadata
conflicts.

The "Metadata Conflicts" panel used to receive every open ``MetadataConflict``
in the project, each with a fully hydrated publication, and narrow it in the
browser. These tests pin the replacement endpoint
(``GET /projects/{id}/metadata-conflicts/page``): four sort keys, source and
field filters, free-text search, and project-wide aggregates that ignore the
filters -- over pages that neither repeat nor skip a conflict.
"""

from __future__ import annotations

import datetime

import pytest

from app.accounts.service import create_user
from app.projects.models import Project, ReviewType
from app.publications.models import MetadataConflict, Publication


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


_BASE_TIME = datetime.datetime(2026, 1, 1, tzinfo=datetime.UTC)


def add_conflict(
    db,
    project: Project,
    *,
    title: str,
    field_name: str = "venue",
    source_name: str = "crossref",
    current_value: str | None = "current",
    proposed_value: str | None = "proposed",
    status: str = "open",
    minutes: int = 0,
) -> MetadataConflict:
    publication = Publication(project_id=project.id, title=title)
    conflict = MetadataConflict(
        publication=publication,
        field_name=field_name,
        current_value=current_value,
        proposed_value=proposed_value,
        source_name=source_name,
        status=status,
        created_at=_BASE_TIME + datetime.timedelta(minutes=minutes),
    )
    db.add_all([publication, conflict])
    db.flush()
    return conflict


def page(client, project: Project, **params) -> dict:
    csrf = login(client)
    response = client.get(
        f"/api/v1/projects/{project.id}/metadata-conflicts/page",
        params=params,
        headers={"X-CSRF-Token": csrf},
    )
    assert response.status_code == 200, response.text
    return response.json()


def fields(payload: dict) -> list[str]:
    return [item["fieldName"] for item in payload["items"]]


# --------------------------------------------------------------------------
# Paging
# --------------------------------------------------------------------------


def test_pages_cover_every_conflict_exactly_once(client, db, project) -> None:
    for index in range(25):
        add_conflict(db, project, title=f"Paper {index:02d}", minutes=index)
    db.commit()

    seen: list[str] = []
    for current in (1, 2, 3):
        payload = page(client, project, pageSize=10, page=current)
        assert payload["total"] == 25
        assert payload["projectTotal"] == 25
        assert payload["pageCount"] == 3
        assert payload["page"] == current
        assert payload["pageSize"] == 10
        assert payload["hasMore"] is (current < 3)
        seen.extend(item["id"] for item in payload["items"])

    assert len(seen) == 25
    assert len(set(seen)) == 25


def test_a_page_past_the_end_is_empty_without_losing_the_totals(
    client, db, project
) -> None:
    for index in range(3):
        add_conflict(db, project, title=f"Paper {index}", minutes=index)
    db.commit()

    payload = page(client, project, pageSize=10, page=4)
    assert payload["items"] == []
    assert payload["total"] == 3
    assert payload["hasMore"] is False


def test_oversized_page_size_and_invalid_paging_are_rejected(
    client, db, project
) -> None:
    add_conflict(db, project, title="Only one")
    db.commit()
    csrf = login(client)

    for params in ({"pageSize": 10_000}, {"pageSize": 0}, {"page": 0}):
        rejected = client.get(
            f"/api/v1/projects/{project.id}/metadata-conflicts/page",
            params=params,
            headers={"X-CSRF-Token": csrf},
        )
        assert rejected.status_code == 422, params

    assert page(client, project, pageSize=200)["pageSize"] == 200


# --------------------------------------------------------------------------
# Sorting
# --------------------------------------------------------------------------


def test_default_sort_is_newest_first(client, db, project) -> None:
    add_conflict(db, project, title="Older", field_name="venue", minutes=0)
    add_conflict(db, project, title="Newer", field_name="doi", minutes=5)
    db.commit()

    payload = page(client, project)
    assert [item["publication"]["title"] for item in payload["items"]] == [
        "Newer",
        "Older",
    ]


def test_sort_by_field_and_source_both_directions(client, db, project) -> None:
    add_conflict(db, project, title="A", field_name="abstract", source_name="merge")
    add_conflict(db, project, title="B", field_name="venue", source_name="crossref")
    add_conflict(
        db, project, title="C", field_name="doi", source_name="semantic_scholar"
    )
    db.commit()

    assert fields(page(client, project, sort="field", direction="asc")) == [
        "abstract",
        "doi",
        "venue",
    ]
    assert fields(page(client, project, sort="field", direction="desc")) == [
        "venue",
        "doi",
        "abstract",
    ]
    assert [
        item["sourceName"]
        for item in page(client, project, sort="source", direction="asc")["items"]
    ] == ["crossref", "merge", "semantic_scholar"]


def test_sort_by_publication_title(client, db, project) -> None:
    add_conflict(db, project, title="Zebra studies")
    add_conflict(db, project, title="Aardvark studies")
    db.commit()

    payload = page(client, project, sort="publication", direction="asc")
    assert [item["publication"]["title"] for item in payload["items"]] == [
        "Aardvark studies",
        "Zebra studies",
    ]


def test_an_unknown_sort_key_is_rejected(client, db, project) -> None:
    add_conflict(db, project, title="Older", minutes=0)
    db.commit()

    rejected = client.get(
        f"/api/v1/projects/{project.id}/metadata-conflicts/page",
        params={"sort": "bogus"},
        headers={"X-CSRF-Token": login(client)},
    )
    assert rejected.status_code == 422


# --------------------------------------------------------------------------
# Filtering and search
# --------------------------------------------------------------------------


def test_filter_by_source_and_field(client, db, project) -> None:
    add_conflict(db, project, title="A", field_name="venue", source_name="merge")
    add_conflict(db, project, title="B", field_name="venue", source_name="crossref")
    add_conflict(db, project, title="C", field_name="doi", source_name="merge")
    db.commit()

    by_source = page(client, project, source="merge")
    assert by_source["total"] == 2
    assert {item["publication"]["title"] for item in by_source["items"]} == {"A", "C"}

    by_field = page(client, project, field="venue")
    assert by_field["total"] == 2
    assert {item["publication"]["title"] for item in by_field["items"]} == {"A", "B"}

    both = page(client, project, source="merge", field="doi")
    assert [item["publication"]["title"] for item in both["items"]] == ["C"]


def test_search_matches_title_field_and_values(client, db, project) -> None:
    add_conflict(
        db,
        project,
        title="Immersive analytics",
        field_name="venue",
        current_value="IEEE VIS",
        proposed_value="IEEE Transactions",
    )
    add_conflict(
        db,
        project,
        title="Unrelated work",
        field_name="doi",
        current_value="10.1/x",
        proposed_value="10.2/y",
    )
    db.commit()

    assert page(client, project, search="immersive")["total"] == 1
    assert page(client, project, search="transactions")["total"] == 1
    assert page(client, project, search="venue")["total"] == 1
    assert page(client, project, search="nothing here")["total"] == 0


def test_search_treats_percent_as_a_literal(client, db, project) -> None:
    add_conflict(db, project, title="Discount 50% off", current_value="a")
    add_conflict(db, project, title="Plain title", current_value="b")
    db.commit()

    assert page(client, project, search="50%")["total"] == 1


# --------------------------------------------------------------------------
# Aggregates ignore the active filters
# --------------------------------------------------------------------------


def test_source_counts_and_field_names_describe_the_whole_project(
    client, db, project
) -> None:
    add_conflict(db, project, title="A", field_name="venue", source_name="merge")
    add_conflict(db, project, title="B", field_name="venue", source_name="merge")
    add_conflict(db, project, title="C", field_name="doi", source_name="crossref")
    db.commit()

    payload = page(client, project, source="crossref")
    assert payload["total"] == 1
    # The aggregates still count every open conflict, so the filter dropdowns
    # and the merge-conflict hint stay complete.
    assert payload["sourceCounts"] == {"merge": 2, "crossref": 1}
    assert payload["fieldNames"] == ["doi", "venue"]
    assert payload["projectTotal"] == 3


def test_resolved_conflicts_and_other_projects_are_excluded(client, db, project) -> None:
    add_conflict(db, project, title="Open one")
    add_conflict(db, project, title="Already resolved", status="accept_proposed")

    other = Project(
        name="Other", review_type=ReviewType.SYSTEMATIC_REVIEW, random_seed="seed2"
    )
    db.add(other)
    db.flush()
    add_conflict(db, other, title="Someone else's conflict")
    db.commit()

    payload = page(client, project)
    assert payload["total"] == 1
    assert payload["projectTotal"] == 1
    assert [item["publication"]["title"] for item in payload["items"]] == ["Open one"]
