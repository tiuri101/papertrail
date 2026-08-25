"""An import may only be attributed to a search source in its own project.

Audit finding: `POST /projects/{id}/imports` checked only that the supplied
`searchSourceId` existed, so a member of project A could attach A's import
batch to project B's documented search -- confirming that B's source exists
and corrupting B's PRISMA source accounting.
"""

from __future__ import annotations

from datetime import date

import pytest
from sqlalchemy import select

from app.accounts.service import create_user
from app.api.errors import NotFoundError
from app.imports.models import ImportBatch, SearchSource
from app.imports.service import resolve_project_search_source
from app.projects.models import Project, ProjectMembership, ReviewType

MEMBER_PASSWORD = "member-password-value"


def build_two_projects(db):
    member = create_user(db, "a-member", "A Member", MEMBER_PASSWORD)
    outsider = create_user(db, "b-owner", "B Owner", "b-owner-password")
    project_a = Project(
        name="Project A", review_type=ReviewType.SYSTEMATIC_REVIEW, random_seed="a"
    )
    project_b = Project(
        name="Project B", review_type=ReviewType.SYSTEMATIC_REVIEW, random_seed="b"
    )
    db.add_all([project_a, project_b])
    db.flush()
    db.add(
        ProjectMembership(
            project_id=project_a.id, user_id=member.id, is_owner=True
        )
    )
    db.add(
        ProjectMembership(
            project_id=project_b.id, user_id=outsider.id, is_owner=True
        )
    )
    source_b = SearchSource(
        project_id=project_b.id,
        source_name="Scopus",
        query="systematic review",
        search_date=date(2026, 1, 1),
        created_by_id=outsider.id,
    )
    db.add(source_b)
    db.flush()
    db.commit()
    return member, project_a, project_b, source_b


def test_import_rejects_a_search_source_from_another_project(client, db) -> None:
    member, project_a, _, source_b = build_two_projects(db)

    csrf = client.post(
        "/api/v1/auth/login",
        json={"username": member.username, "password": MEMBER_PASSWORD},
    ).json()["csrfToken"]
    response = client.post(
        f"/api/v1/projects/{project_a.id}/imports",
        data={"searchSourceId": source_b.id},
        files={"file": ("papers.csv", b"title\nA paper\n", "text/csv")},
        headers={"X-CSRF-Token": csrf},
    )

    # 404, not 403: the response must not confirm that the other project's
    # search source exists.
    assert response.status_code == 404, response.text
    assert response.json()["error"]["code"] == "not_found"
    assert list(db.scalars(select(ImportBatch))) == []


def test_import_rejects_an_unknown_search_source(client, db) -> None:
    member, project_a, _, _ = build_two_projects(db)

    csrf = client.post(
        "/api/v1/auth/login",
        json={"username": member.username, "password": MEMBER_PASSWORD},
    ).json()["csrfToken"]
    response = client.post(
        f"/api/v1/projects/{project_a.id}/imports",
        data={"searchSourceId": "00000000-0000-0000-0000-000000000000"},
        files={"file": ("papers.csv", b"title\nA paper\n", "text/csv")},
        headers={"X-CSRF-Token": csrf},
    )

    # Identical response to the cross-project case -- that is the point.
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"
    assert list(db.scalars(select(ImportBatch))) == []


def test_import_accepts_the_projects_own_search_source(client, db) -> None:
    member, project_a, _, _ = build_two_projects(db)

    csrf = client.post(
        "/api/v1/auth/login",
        json={"username": member.username, "password": MEMBER_PASSWORD},
    ).json()["csrfToken"]
    created = client.post(
        f"/api/v1/projects/{project_a.id}/searches",
        json={
            "sourceName": "PubMed",
            "query": "review",
            "searchDate": "2026-01-02",
            "exportedResultCount": 1,
        },
        headers={"X-CSRF-Token": csrf},
    )
    assert created.status_code == 201, created.text
    source_a_id = created.json()["id"]

    response = client.post(
        f"/api/v1/projects/{project_a.id}/imports",
        data={"searchSourceId": source_a_id},
        files={"file": ("papers.csv", b"title\nA paper\n", "text/csv")},
        headers={"X-CSRF-Token": csrf},
    )

    assert response.status_code == 202, response.text
    batch = db.scalar(select(ImportBatch))
    assert batch is not None
    assert batch.project_id == project_a.id
    assert batch.search_source_id == source_a_id


def test_resolve_project_search_source_enforces_ownership(db) -> None:
    _, project_a, project_b, source_b = build_two_projects(db)

    assert resolve_project_search_source(db, project_a.id, None) is None
    assert (
        resolve_project_search_source(db, project_b.id, source_b.id) is source_b
    )
    with pytest.raises(NotFoundError):
        resolve_project_search_source(db, project_a.id, source_b.id)
