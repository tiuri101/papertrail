"""Paging and filtering the audit log.

The endpoint used to return only the newest ``limit`` events with no way to
reach the rest, and every filter the UI offered narrowed that page rather than
the project's history. These cover the whole-table behaviour the pageable
endpoint replaces it with.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from app.accounts.service import create_user
from app.audit.models import AuditEvent
from app.audit.query import AuditFilters, audit_page
from app.projects.models import Project, ProjectMembership, ReviewType


def login(client, username: str, password: str) -> str:
    response = client.post(
        "/api/v1/auth/login", json={"username": username, "password": password}
    )
    assert response.status_code == 200
    return response.json()["csrfToken"]


BASE_TIME = datetime(2026, 1, 1, 12, 0, tzinfo=UTC)


def make_project(db, name: str = "Audit Review") -> Project:
    project = Project(
        name=name, review_type=ReviewType.SYSTEMATIC_REVIEW, random_seed="seed"
    )
    db.add(project)
    db.flush()
    return project


def add_event(
    db,
    project: Project,
    *,
    index: int,
    action: str = "project.updated",
    entity_type: str = "project",
    entity_id: str | None = None,
    actor_id: str | None = None,
    summary: str | None = None,
    created_at: datetime | None = None,
) -> AuditEvent:
    event = AuditEvent(
        project_id=project.id,
        action=action,
        entity_type=entity_type,
        entity_id=entity_id if entity_id is not None else project.id,
        actor_id=actor_id,
        summary=summary if summary is not None else f"Event {index}",
        event_metadata={},
        # Explicit, increasing timestamps: the default is "now", and a batch
        # written in one transaction can share a timestamp to the microsecond.
        created_at=created_at or (BASE_TIME + timedelta(minutes=index)),
    )
    db.add(event)
    db.flush()
    return event


def collect_all(db, project_id: str, *, limit: int, **kwargs) -> list[str]:
    """Every summary reachable by following nextCursor to the end."""
    summaries: list[str] = []
    cursor: str | None = None
    for _ in range(50):  # guards against a cursor that never advances
        page = audit_page(db, project_id, limit=limit, cursor=cursor, **kwargs)
        summaries.extend(item["summary"] for item in page.items)
        if not page.has_more:
            return summaries
        assert page.next_cursor is not None
        cursor = page.next_cursor
    raise AssertionError("pagination did not terminate")


def test_pages_cover_every_event_exactly_once_newest_first(db) -> None:
    project = make_project(db)
    for index in range(25):
        add_event(db, project, index=index)
    db.commit()

    first = audit_page(db, project.id, limit=10)
    assert len(first.items) == 10
    assert first.total == 25
    assert first.has_more is True
    assert first.next_cursor == first.items[-1]["id"]
    # Newest first.
    assert first.items[0]["summary"] == "Event 24"
    assert first.items[-1]["summary"] == "Event 15"

    second = audit_page(db, project.id, limit=10, cursor=first.next_cursor)
    assert second.items[0]["summary"] == "Event 14"
    assert second.total == 25
    assert second.has_more is True

    third = audit_page(db, project.id, limit=10, cursor=second.next_cursor)
    assert len(third.items) == 5
    assert third.has_more is False
    assert third.next_cursor is None

    walked = collect_all(db, project.id, limit=10)
    assert walked == [f"Event {index}" for index in reversed(range(25))]
    assert len(set(walked)) == 25


def test_ordering_is_stable_when_events_share_a_timestamp(db) -> None:
    """A burst recorded in one transaction shares ``created_at`` exactly.

    Without the id tiebreak, such rows can be returned in a different order per
    query, which makes a keyset page overlap the previous one or skip rows
    between them.
    """
    project = make_project(db)
    same_moment = BASE_TIME
    for index in range(6):
        add_event(db, project, index=index, created_at=same_moment)
    db.commit()

    walked = collect_all(db, project.id, limit=2)
    assert len(walked) == 6
    assert len(set(walked)) == 6
    # And the same order every time it is walked.
    assert collect_all(db, project.id, limit=3) == walked
    assert [item["summary"] for item in audit_page(db, project.id, limit=6).items] == walked


def test_filters_narrow_the_whole_table_not_just_a_page(db) -> None:
    alice = create_user(db, "alice", "Alice", "secret-password")
    bob = create_user(db, "bob", "Bob", "secret-password")
    project = make_project(db)
    # The matching event is the *oldest*, so it falls outside any first page
    # of a client-side filter over the newest rows.
    add_event(
        db,
        project,
        index=0,
        action="publication.deleted",
        entity_type="publication",
        entity_id="pub-1",
        actor_id=bob.id,
        summary="Removed a duplicate record",
    )
    for index in range(1, 30):
        add_event(db, project, index=index, actor_id=alice.id)
    db.commit()

    by_action = audit_page(
        db, project.id, limit=5, filters=AuditFilters(action="publication.deleted")
    )
    assert by_action.total == 1
    assert by_action.has_more is False
    assert [item["summary"] for item in by_action.items] == ["Removed a duplicate record"]

    by_entity = audit_page(
        db,
        project.id,
        limit=5,
        filters=AuditFilters(entity_type="publication", entity_id="pub-1"),
    )
    assert [item["summary"] for item in by_entity.items] == ["Removed a duplicate record"]

    by_actor = audit_page(db, project.id, limit=5, filters=AuditFilters(actor_id=bob.id))
    assert by_actor.total == 1
    assert by_actor.items[0]["actorUsername"] == "Bob"

    by_search = audit_page(
        db, project.id, limit=5, filters=AuditFilters(search="duplicate record")
    )
    assert by_search.total == 1

    assert audit_page(db, project.id, limit=5, filters=AuditFilters(actor_id=alice.id)).total == 29


def test_system_events_are_selectable_and_never_attributed_to_a_user(db) -> None:
    project = make_project(db)
    actor = create_user(db, "alice", "Alice", "secret-password")
    add_event(db, project, index=0, actor_id=None, summary="Enrichment finished")
    add_event(db, project, index=1, actor_id=actor.id, summary="Alice edited")
    db.commit()

    page = audit_page(db, project.id, limit=10, filters=AuditFilters(actor_id="system"))
    assert [item["summary"] for item in page.items] == ["Enrichment finished"]
    assert page.items[0]["actorUsername"] is None


def test_date_range_filters_bound_the_history(db) -> None:
    project = make_project(db)
    for index in range(10):
        add_event(db, project, index=index)
    db.commit()

    page = audit_page(
        db,
        project.id,
        limit=50,
        filters=AuditFilters(
            since=BASE_TIME + timedelta(minutes=3),
            until=BASE_TIME + timedelta(minutes=6),
        ),
    )
    assert [item["summary"] for item in page.items] == [
        "Event 6",
        "Event 5",
        "Event 4",
        "Event 3",
    ]
    assert page.total == 4


def test_a_cursor_never_leaks_another_projects_events(db) -> None:
    project = make_project(db, "One")
    other = make_project(db, "Two")
    add_event(db, project, index=0)
    other_event = add_event(db, other, index=0)
    db.commit()

    page = audit_page(db, project.id, limit=10)
    assert page.total == 1

    # A cursor from a different project names no row in this one.
    try:
        audit_page(db, project.id, limit=10, cursor=other_event.id)
    except Exception as error:  # noqa: BLE001 - asserting the domain error below
        assert getattr(error, "code", None) == "invalid_cursor"
    else:
        raise AssertionError("expected the foreign cursor to be rejected")


def test_endpoint_returns_a_page_envelope_and_follows_its_cursor(client, db) -> None:
    admin = create_user(db, "admin", "Admin", "secret-password", is_admin=True)
    project = make_project(db)
    db.add(ProjectMembership(project_id=project.id, user_id=admin.id, is_owner=True))
    for index in range(7):
        add_event(db, project, index=index, actor_id=admin.id)
    db.commit()

    csrf = login(client, "admin", "secret-password")
    headers = {"X-CSRF-Token": csrf}

    first = client.get(
        f"/api/v1/projects/{project.id}/audit?limit=3", headers=headers
    )
    assert first.status_code == 200
    body = first.json()
    assert body["total"] == 7
    assert body["hasMore"] is True
    assert [item["summary"] for item in body["items"]] == [
        "Event 6",
        "Event 5",
        "Event 4",
    ]

    second = client.get(
        f"/api/v1/projects/{project.id}/audit?limit=3&cursor={body['nextCursor']}",
        headers=headers,
    )
    assert [item["summary"] for item in second.json()["items"]] == [
        "Event 3",
        "Event 2",
        "Event 1",
    ]

    last = client.get(
        f"/api/v1/projects/{project.id}/audit"
        f"?limit=3&cursor={second.json()['nextCursor']}",
        headers=headers,
    )
    assert last.json()["hasMore"] is False
    assert last.json()["nextCursor"] is None
    assert [item["summary"] for item in last.json()["items"]] == ["Event 0"]


def test_endpoint_filters_server_side(client, db) -> None:
    admin = create_user(db, "admin", "Admin", "secret-password", is_admin=True)
    project = make_project(db)
    db.add(ProjectMembership(project_id=project.id, user_id=admin.id, is_owner=True))
    add_event(
        db,
        project,
        index=0,
        action="publication.deleted",
        entity_type="publication",
        entity_id="pub-1",
        actor_id=admin.id,
        summary="Removed pub-1",
    )
    for index in range(1, 12):
        add_event(db, project, index=index, actor_id=admin.id)
    db.commit()

    csrf = login(client, "admin", "secret-password")
    headers = {"X-CSRF-Token": csrf}

    response = client.get(
        f"/api/v1/projects/{project.id}/audit"
        "?limit=5&entityType=publication&entityId=pub-1",
        headers=headers,
    )
    body = response.json()
    assert body["total"] == 1
    assert body["hasMore"] is False
    assert [item["summary"] for item in body["items"]] == ["Removed pub-1"]

    searched = client.get(
        f"/api/v1/projects/{project.id}/audit?limit=5&search=Removed", headers=headers
    )
    assert searched.json()["total"] == 1


def test_filter_options_come_from_the_whole_log(client, db) -> None:
    admin = create_user(db, "admin", "Admin", "secret-password", is_admin=True)
    project = make_project(db)
    db.add(ProjectMembership(project_id=project.id, user_id=admin.id, is_owner=True))
    # The distinctive action is the oldest event, well outside any first page.
    add_event(
        db,
        project,
        index=0,
        action="publication.deleted",
        entity_type="publication",
        actor_id=None,
    )
    for index in range(1, 40):
        add_event(db, project, index=index, actor_id=admin.id)
    db.commit()

    csrf = login(client, "admin", "secret-password")
    options = client.get(
        f"/api/v1/projects/{project.id}/audit/filters",
        headers={"X-CSRF-Token": csrf},
    ).json()

    assert options["actions"] == ["project.updated", "publication.deleted"]
    assert options["entityTypes"] == ["project", "publication"]
    assert {actor["name"] for actor in options["actors"]} == {"Admin", "System"}
    assert {actor["id"] for actor in options["actors"]} == {admin.id, "system"}


def test_rejects_a_cursor_that_names_no_event(client, db) -> None:
    admin = create_user(db, "admin", "Admin", "secret-password", is_admin=True)
    project = make_project(db)
    db.add(ProjectMembership(project_id=project.id, user_id=admin.id, is_owner=True))
    add_event(db, project, index=0, actor_id=admin.id)
    db.commit()

    csrf = login(client, "admin", "secret-password")
    response = client.get(
        f"/api/v1/projects/{project.id}/audit?cursor=not-a-real-event",
        headers={"X-CSRF-Token": csrf},
    )
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "invalid_cursor"
