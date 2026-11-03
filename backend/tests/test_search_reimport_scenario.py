"""End-to-end: a second search export overlapping one already being screened,
then deleting the first export.

Import 1 brings in Paper 1-3, Paper 1 and 2 get screened, import 2 brings in
Paper 1 and 3 again, and finally search 1 is deleted. Which papers survive --
and whether Paper 1's screening survives with it -- depends on whether the
overlapping records were merged first.
"""

from sqlalchemy import select

from app.accounts.service import create_user
from app.core.config import get_settings
from app.deduplication.models import DuplicateCandidate, PublicationMerge
from app.jobs.worker import execute_next_job
from app.projects.models import Project, ProjectStage
from app.publications.models import Publication
from app.screening.models import (
    ScreeningDecision,
    ScreeningOutcome,
    ScreeningWorkItem,
    WorkItemStatus,
)
from app.screening.service import screened_publication_ids

CSV_HEADER = "Document Title,Authors,Abstract,DOI\n"
PAPER_ROWS = {
    "Paper 1": "Paper 1,Doe,Summary one,10.1/p1\n",
    "Paper 2": "Paper 2,Roe,Summary two,10.1/p2\n",
    "Paper 3": "Paper 3,Poe,Summary three,10.1/p3\n",
}


def _login(client) -> str:
    return client.post(
        "/api/v1/auth/login", json={"username": "admin", "password": "secret-password"}
    ).json()["csrfToken"]


def _run_queued_jobs(session_factory) -> None:
    while execute_next_job(session_factory, worker_id="test-worker"):
        pass


def _import_search(
    client, csrf: str, session_factory, project_id: str, name: str, titles: list[str]
) -> str:
    search = client.post(
        f"/api/v1/projects/{project_id}/searches",
        json={"sourceName": name, "query": "x", "searchDate": "2026-07-30"},
        headers={"X-CSRF-Token": csrf},
    )
    assert search.status_code == 201
    body = CSV_HEADER + "".join(PAPER_ROWS[title] for title in titles)
    response = client.post(
        f"/api/v1/projects/{project_id}/imports",
        data={"searchSourceId": search.json()["id"]},
        files={"file": (f"{name}.csv", body.encode(), "text/csv")},
        headers={"X-CSRF-Token": csrf},
    )
    assert response.status_code == 202
    _run_queued_jobs(session_factory)
    return str(search.json()["id"])


def _screen(db, publication_id: str, reviewer_id: str) -> None:
    work_items = list(
        db.scalars(
            select(ScreeningWorkItem).where(
                ScreeningWorkItem.publication_id == publication_id
            )
        )
    )
    assert work_items
    for work_item in work_items:
        work_item.assigned_reviewer_id = reviewer_id
        work_item.status = WorkItemStatus.SUBMITTED
        db.add(
            ScreeningDecision(
                work_item_id=work_item.id,
                reviewer_id=reviewer_id,
                outcome=ScreeningOutcome.INCLUDE,
                criteria_answers={},
                version=1,
                is_current=True,
            )
        )
    db.commit()


def _active_by_title(db, project_id: str) -> dict[str, list[str]]:
    by_title: dict[str, list[str]] = {}
    for publication in db.scalars(
        select(Publication).where(
            Publication.project_id == project_id, Publication.is_active.is_(True)
        )
    ):
        by_title.setdefault(publication.title, []).append(publication.id)
    return by_title


def _delete_search(client, csrf: str, project_id: str, search_id: str) -> dict:
    response = client.delete(
        f"/api/v1/projects/{project_id}/searches/{search_id}",
        params={"force": "true"},
        headers={"X-CSRF-Token": csrf},
    )
    assert response.status_code == 200
    assert response.json()["deleted"] is True
    return dict(response.json())


def _screened_overlap_project(client, db, session_factory, tmp_path, monkeypatch):
    """Search 1 (Paper 1-3) imported and through duplicate review, Paper 1 and
    2 screened, then search 2 (Paper 1 and 3) imported mid-screening."""
    monkeypatch.setenv("PAPERTRAIL_IMPORT_DIR", str(tmp_path / "imports"))
    get_settings.cache_clear()
    admin = create_user(db, "admin", "Administrator", "secret-password", is_admin=True)
    db.commit()
    csrf = _login(client)
    project_id = client.post(
        "/api/v1/projects",
        json={"name": "Review", "reviewType": "systematic_review"},
        headers={"X-CSRF-Token": csrf},
    ).json()["id"]
    for path, payload in [
        ("research-questions", {"text": "How is X studied?"}),
        ("criteria", {"text": "Uses X", "kind": "inclusion"}),
        ("criteria", {"text": "Not peer reviewed", "kind": "exclusion"}),
    ]:
        client.post(
            f"/api/v1/projects/{project_id}/{path}",
            json=payload,
            headers={"X-CSRF-Token": csrf},
        )

    search_1 = _import_search(
        client, csrf, session_factory, project_id, "search-1",
        ["Paper 1", "Paper 2", "Paper 3"],
    )
    ready = client.post(
        f"/api/v1/projects/{project_id}/ready", headers={"X-CSRF-Token": csrf}
    )
    assert ready.status_code == 202, ready.json()
    # Duplicate detection finds nothing among three distinct papers, so the
    # project moves straight on to title/abstract screening.
    _run_queued_jobs(session_factory)
    db.expire_all()
    assert db.get(Project, project_id).stage == ProjectStage.TITLE_ABSTRACT

    originals = {title: ids[0] for title, ids in _active_by_title(db, project_id).items()}
    _screen(db, originals["Paper 1"], admin.id)
    _screen(db, originals["Paper 2"], admin.id)

    _import_search(
        client, csrf, session_factory, project_id, "search-2", ["Paper 1", "Paper 3"]
    )
    db.expire_all()
    return csrf, project_id, search_1, originals


def test_reimport_mid_screening_then_deleting_the_first_search(
    client, db, session_factory, tmp_path, monkeypatch
) -> None:
    csrf, project_id, search_1, originals = _screened_overlap_project(
        client, db, session_factory, tmp_path, monkeypatch
    )

    # Importing during screening runs no duplicate detection: search 2's
    # Paper 1 and 3 are separate records, enrolled straight into screening.
    active = _active_by_title(db, project_id)
    assert len(active["Paper 1"]) == 2
    assert len(active["Paper 3"]) == 2
    assert db.scalar(select(DuplicateCandidate.id)) is None
    reimported_paper_1 = next(
        pid for pid in active["Paper 1"] if pid != originals["Paper 1"]
    )
    assert db.scalar(
        select(ScreeningWorkItem.id).where(
            ScreeningWorkItem.publication_id == reimported_paper_1
        )
    )

    result = _delete_search(client, csrf, project_id, search_1)
    assert result["publicationCount"] == 3
    assert result["screenedPublicationCount"] == 2

    db.expire_all()
    active = _active_by_title(db, project_id)
    # Paper 1 and 3 survive, but only as search 2's copies; Paper 2 is gone.
    assert set(active) == {"Paper 1", "Paper 3"}
    assert active["Paper 1"] == [reimported_paper_1]
    assert originals["Paper 1"] not in active["Paper 1"]
    assert originals["Paper 3"] not in active["Paper 3"]
    # Paper 1's screening stayed on the removed original, so it must be redone.
    assert screened_publication_ids(db, [reimported_paper_1]) == set()


def test_reimport_merged_via_duplicate_review_then_deleting_the_first_search(
    client, db, session_factory, tmp_path, monkeypatch
) -> None:
    csrf, project_id, search_1, originals = _screened_overlap_project(
        client, db, session_factory, tmp_path, monkeypatch
    )

    # Merging requires duplicate detection, which only runs on entering
    # duplicate review -- and moving back there resets screening.
    moved = client.post(
        f"/api/v1/projects/{project_id}/move-back",
        json={"targetStage": "duplicate_review"},
        headers={"X-CSRF-Token": csrf},
    )
    assert moved.status_code == 200, moved.json()
    db.expire_all()

    # Same DOI, so both pairs auto-merge, keeping the older (search 1) record.
    merges = list(db.scalars(select(PublicationMerge)))
    assert {merge.canonical_publication_id for merge in merges} == {
        originals["Paper 1"],
        originals["Paper 3"],
    }
    assert screened_publication_ids(db, originals.values()) == set()

    result = _delete_search(client, csrf, project_id, search_1)
    assert result["publicationCount"] == 1
    assert result["screenedPublicationCount"] == 0

    db.expire_all()
    active = _active_by_title(db, project_id)
    # The merged records now also trace back to search 2, so they stay.
    assert active == {
        "Paper 1": [originals["Paper 1"]],
        "Paper 3": [originals["Paper 3"]],
    }
