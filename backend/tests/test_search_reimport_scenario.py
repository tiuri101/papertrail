"""Duplicate detection for records imported while screening is under way.

The scenario these build on: search 1 brings in Paper 1-3, Paper 1 and 2 get
screened, then search 2 brings in Paper 1 and 3 again. Search 2's records are
checked against the project before anyone can screen them; a merge always
keeps the record that already carries screening decisions, so deleting search
1 afterwards removes only Paper 2.
"""

from typing import Any

from sqlalchemy import select

from app.accounts.service import create_user
from app.conflicts.service import (
    refresh_automatic_final_decision,
    valid_final_decision,
)
from app.core.config import get_settings
from app.deduplication.jobs import release_duplicate_check_after_failure
from app.deduplication.models import DuplicateCandidate, PublicationMerge
from app.jobs.models import BackgroundJob, JobStatus
from app.jobs.worker import execute_next_job
from app.projects.models import Project, ProjectStage, ScreeningStage
from app.publications.models import Publication
from app.screening.models import (
    ScreeningDecision,
    ScreeningOutcome,
    ScreeningWorkItem,
    WorkItemStatus,
)
from app.screening.service import create_screening_work_items, screened_publication_ids

CSV_HEADER = "Document Title,Authors,Abstract,DOI\n"
PAPER_ROWS = {
    "Paper 1": "Paper 1,Doe,Summary one,10.1/p1\n",
    "Paper 2": "Paper 2,Roe,Summary two,10.1/p2\n",
    "Paper 3": "Paper 3,Poe,Summary three,10.1/p3\n",
    # Same work as Paper 1 but without a DOI and a slightly different title:
    # a fuzzy match that needs a reviewer, never an automatic merge.
    "Paper 1 variant": "Paper 1.,Doe,Summary one,\n",
    # A different title but Paper 1's DOI: an exact-identifier match.
    "Paper 1 retitled": "Totally different heading,Moe,Other,10.1/p1\n",
}
TA = ScreeningStage.TITLE_ABSTRACT


def _login(client) -> str:
    return client.post(
        "/api/v1/auth/login", json={"username": "admin", "password": "secret-password"}
    ).json()["csrfToken"]


def _run_queued_jobs(session_factory) -> None:
    while execute_next_job(session_factory, worker_id="test-worker"):
        pass


def _import_search(
    client,
    csrf: str,
    session_factory,
    project_id: str,
    name: str,
    titles: list[str],
    *,
    run_jobs: bool = True,
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
    if run_jobs:
        _run_queued_jobs(session_factory)
    else:
        # Only the parse job: whatever it queues next is left for the caller.
        assert execute_next_job(session_factory, worker_id="test-worker") is True
    return str(search.json()["id"])


def _screen(
    db, publication_id: str, reviewer_id: str, outcome=ScreeningOutcome.INCLUDE
) -> None:
    """Submit a decision on every slot, then finalize like a submission would."""
    work_items = list(
        db.scalars(
            select(ScreeningWorkItem).where(
                ScreeningWorkItem.publication_id == publication_id,
                ScreeningWorkItem.stage == TA,
            )
        )
    )
    assert work_items, "publication is not enrolled in screening"
    for work_item in work_items:
        work_item.assigned_reviewer_id = reviewer_id
        work_item.status = WorkItemStatus.SUBMITTED
        db.add(
            ScreeningDecision(
                work_item_id=work_item.id,
                reviewer_id=reviewer_id,
                outcome=outcome,
                criteria_answers={},
                version=1,
                is_current=True,
            )
        )
    db.flush()
    refresh_automatic_final_decision(db, publication_id, TA)
    db.commit()


def _work_item_count(db, publication_id: str) -> int:
    return len(
        list(
            db.scalars(
                select(ScreeningWorkItem.id).where(
                    ScreeningWorkItem.publication_id == publication_id
                )
            )
        )
    )


def _active_by_title(db, project_id: str) -> dict[str, list[str]]:
    by_title: dict[str, list[str]] = {}
    for publication in db.scalars(
        select(Publication).where(
            Publication.project_id == project_id, Publication.is_active.is_(True)
        )
    ):
        by_title.setdefault(publication.title, []).append(publication.id)
    return by_title


def _new_publication_id(db, project_id: str, title: str, known: set[str]) -> str:
    ids = [
        pid for pid in _active_by_title(db, project_id).get(title, []) if pid not in known
    ]
    assert len(ids) == 1, ids
    return ids[0]


def _unresolved_candidate(db) -> DuplicateCandidate:
    candidate = db.scalar(
        select(DuplicateCandidate).where(DuplicateCandidate.status == "unresolved")
    )
    assert candidate is not None
    return candidate


def _post(client, csrf: str, path: str, payload: dict[str, Any] | None = None):
    return client.post(
        f"/api/v1/projects/{path}", json=payload or {}, headers={"X-CSRF-Token": csrf}
    )


def _delete_search(client, csrf: str, project_id: str, search_id: str) -> dict:
    response = client.delete(
        f"/api/v1/projects/{project_id}/searches/{search_id}",
        params={"force": "true"},
        headers={"X-CSRF-Token": csrf},
    )
    assert response.status_code == 200
    assert response.json()["deleted"] is True
    return dict(response.json())


def _screening_project(client, db, session_factory, tmp_path, monkeypatch):
    """Search 1 (Paper 1-3) imported and through duplicate review, with
    Paper 1 and 2 screened."""
    monkeypatch.setenv("PAPERTRAIL_IMPORT_DIR", str(tmp_path / "imports"))
    # No Crossref / Semantic Scholar calls from the drained job queue.
    monkeypatch.setenv("PAPERTRAIL_DUPLICATE_ASSESSMENT_ENABLED", "false")
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
    ready = _post(client, csrf, f"{project_id}/ready")
    assert ready.status_code == 202, ready.json()
    # Duplicate detection finds nothing among three distinct papers, so the
    # project moves straight on to title/abstract screening.
    _run_queued_jobs(session_factory)
    db.expire_all()
    assert db.get(Project, project_id).stage == ProjectStage.TITLE_ABSTRACT

    originals = {title: ids[0] for title, ids in _active_by_title(db, project_id).items()}
    _screen(db, originals["Paper 1"], admin.id)
    _screen(db, originals["Paper 2"], admin.id)
    return csrf, project_id, search_1, originals, admin


def test_reimport_mid_screening_merges_into_the_screened_records(
    client, db, session_factory, tmp_path, monkeypatch
) -> None:
    csrf, project_id, search_1, originals, _admin = _screening_project(
        client, db, session_factory, tmp_path, monkeypatch
    )
    _import_search(
        client, csrf, session_factory, project_id, "search-2", ["Paper 1", "Paper 3"]
    )
    db.expire_all()

    # Same DOI: both pairs auto-merge into search 1's records, so Paper 1
    # keeps its screening and nobody is asked to screen it twice.
    merges = list(db.scalars(select(PublicationMerge)))
    assert {merge.canonical_publication_id for merge in merges} == {
        originals["Paper 1"],
        originals["Paper 3"],
    }
    assert [merge.stage_at_merge for merge in merges] == [
        ProjectStage.TITLE_ABSTRACT.value
    ] * 2
    for merge in merges:
        assert _work_item_count(db, merge.merged_publication_id) == 0
    assert db.get(Project, project_id).stage == ProjectStage.TITLE_ABSTRACT

    result = _delete_search(client, csrf, project_id, search_1)
    assert result["publicationCount"] == 1
    assert result["screenedPublicationCount"] == 1

    db.expire_all()
    assert _active_by_title(db, project_id) == {
        "Paper 1": [originals["Paper 1"]],
        "Paper 3": [originals["Paper 3"]],
    }
    assert screened_publication_ids(db, [originals["Paper 1"]]) == {
        originals["Paper 1"]
    }


def test_a_manually_added_duplicate_is_checked_and_merged_into_the_screened_record(
    client, db, session_factory, tmp_path, monkeypatch
) -> None:
    csrf, project_id, _search_1, originals, _admin = _screening_project(
        client, db, session_factory, tmp_path, monkeypatch
    )
    added = _post(
        client, csrf, f"{project_id}/publications",
        {"title": "Paper 1 (added by hand)", "doi": "10.1/p1"},
    )
    assert added.status_code == 201, added.json()
    new_id = added.json()["id"]
    db.expire_all()
    assert db.get(Publication, new_id).duplicate_check_pending is True
    create_screening_work_items(db, db.get(Project, project_id), TA)
    db.commit()
    assert _work_item_count(db, new_id) == 0

    _run_queued_jobs(session_factory)
    db.expire_all()
    assert db.get(Publication, new_id).merged_into_id == originals["Paper 1"]
    assert screened_publication_ids(db, [originals["Paper 1"]])


def test_a_manually_added_distinct_publication_reaches_screening_once_checked(
    client, db, session_factory, tmp_path, monkeypatch
) -> None:
    csrf, project_id, _search_1, _originals, _admin = _screening_project(
        client, db, session_factory, tmp_path, monkeypatch
    )
    added = _post(
        client, csrf, f"{project_id}/publications",
        {"title": "An entirely unrelated study", "doi": "10.1/other"},
    )
    assert added.status_code == 201, added.json()
    new_id = added.json()["id"]

    _run_queued_jobs(session_factory)
    db.expire_all()
    assert db.get(Publication, new_id).duplicate_check_pending is False
    assert _work_item_count(db, new_id) > 0


def test_records_imported_mid_screening_wait_for_their_duplicate_check(
    client, db, session_factory, tmp_path, monkeypatch
) -> None:
    csrf, project_id, _search_1, originals, _admin = _screening_project(
        client, db, session_factory, tmp_path, monkeypatch
    )
    _import_search(
        client, csrf, session_factory, project_id, "search-2", ["Paper 1"],
        run_jobs=False,
    )
    db.expire_all()
    new_id = _new_publication_id(db, project_id, "Paper 1", set(originals.values()))
    assert db.get(Publication, new_id).duplicate_check_pending is True
    # The "load next" backfill must not slip it into screening either.
    create_screening_work_items(db, db.get(Project, project_id), TA)
    db.commit()
    assert _work_item_count(db, new_id) == 0
    assert db.scalar(
        select(BackgroundJob.id).where(BackgroundJob.job_type == "detect_duplicates")
    )

    _run_queued_jobs(session_factory)
    db.expire_all()
    assert db.get(Publication, new_id).merged_into_id == originals["Paper 1"]


def test_a_fuzzy_match_waits_for_a_reviewer_and_not_duplicate_releases_it(
    client, db, session_factory, tmp_path, monkeypatch
) -> None:
    csrf, project_id, _search_1, originals, _admin = _screening_project(
        client, db, session_factory, tmp_path, monkeypatch
    )
    _import_search(
        client, csrf, session_factory, project_id, "search-2", ["Paper 1 variant"]
    )
    db.expire_all()
    new_id = _new_publication_id(db, project_id, "Paper 1.", set())
    candidate = _unresolved_candidate(db)
    assert {candidate.publication_a_id, candidate.publication_b_id} == {
        new_id,
        originals["Paper 1"],
    }
    assert db.get(Publication, new_id).duplicate_check_pending is False
    create_screening_work_items(db, db.get(Project, project_id), TA)
    db.commit()
    assert _work_item_count(db, new_id) == 0

    resolved = _post(
        client, csrf, f"{project_id}/duplicates/{candidate.id}/not-duplicate"
    )
    assert resolved.status_code == 200, resolved.json()
    db.expire_all()
    assert _work_item_count(db, new_id) > 0


def test_a_merge_must_keep_the_record_with_screening_decisions(
    client, db, session_factory, tmp_path, monkeypatch
) -> None:
    csrf, project_id, _search_1, originals, _admin = _screening_project(
        client, db, session_factory, tmp_path, monkeypatch
    )
    _import_search(
        client, csrf, session_factory, project_id, "search-2", ["Paper 1 variant"]
    )
    db.expire_all()
    new_id = _new_publication_id(db, project_id, "Paper 1.", set())
    candidate = _unresolved_candidate(db)

    refused = _post(
        client, csrf, f"{project_id}/duplicates/{candidate.id}/merge",
        {"canonicalPublicationId": new_id},
    )
    assert refused.status_code == 409

    merged = _post(
        client, csrf, f"{project_id}/duplicates/{candidate.id}/merge",
        {"canonicalPublicationId": originals["Paper 1"]},
    )
    assert merged.status_code == 200, merged.json()
    db.expire_all()
    assert db.get(Publication, new_id).merged_into_id == originals["Paper 1"]
    assert screened_publication_ids(db, [originals["Paper 1"]])


def test_undoing_a_screening_stage_merge_returns_the_pair_to_the_queue(
    client, db, session_factory, tmp_path, monkeypatch
) -> None:
    csrf, project_id, _search_1, originals, _admin = _screening_project(
        client, db, session_factory, tmp_path, monkeypatch
    )
    _import_search(
        client, csrf, session_factory, project_id, "search-2", ["Paper 1"]
    )
    db.expire_all()
    merge = db.scalar(select(PublicationMerge))
    assert merge is not None

    undone = _post(client, csrf, f"{project_id}/merges/{merge.id}/reverse")
    assert undone.status_code == 200, undone.json()
    db.expire_all()
    restored = db.get(Publication, merge.merged_publication_id)
    assert restored.is_active is True
    # Back to an unresolved pair: the restored record waits for a decision.
    assert _unresolved_candidate(db).id == merge.candidate_id
    create_screening_work_items(db, db.get(Project, project_id), TA)
    db.commit()
    assert _work_item_count(db, restored.id) == 0


def _both_screened_pair(client, db, session_factory, tmp_path, monkeypatch):
    """Paper 1 screened as INCLUDE, plus a record with Paper 1's DOI that got
    screened as EXCLUDE because its duplicate check failed for good."""
    csrf, project_id, _search_1, originals, admin = _screening_project(
        client, db, session_factory, tmp_path, monkeypatch
    )
    _import_search(
        client, csrf, session_factory, project_id, "search-2",
        ["Paper 1 retitled"], run_jobs=False,
    )
    job = db.scalar(
        select(BackgroundJob).where(
            BackgroundJob.job_type == "detect_duplicates",
            BackgroundJob.status == JobStatus.QUEUED,
        )
    )
    assert job is not None
    db.delete(job)
    release_duplicate_check_after_failure(db, job, "provider outage")
    db.commit()
    db.expire_all()
    other_id = _new_publication_id(db, project_id, "Totally different heading", set())
    assert db.get(Publication, other_id).duplicate_check_pending is False
    assert _work_item_count(db, other_id) > 0
    _screen(db, other_id, admin.id, ScreeningOutcome.EXCLUDE)
    return csrf, project_id, originals, other_id


def test_a_failed_duplicate_check_releases_records_into_screening(
    client, db, session_factory, tmp_path, monkeypatch
) -> None:
    _both_screened_pair(client, db, session_factory, tmp_path, monkeypatch)


def test_two_screened_records_are_never_merged_automatically(
    client, db, session_factory, tmp_path, monkeypatch
) -> None:
    csrf, project_id, originals, other_id = _both_screened_pair(
        client, db, session_factory, tmp_path, monkeypatch
    )
    rerun = _post(client, csrf, f"{project_id}/duplicates/detect")
    assert rerun.status_code == 202, rerun.json()
    _run_queued_jobs(session_factory)
    db.expire_all()

    candidate = _unresolved_candidate(db)
    assert "exact_doi" in candidate.match_reasons
    assert db.scalar(select(PublicationMerge.id)) is None
    assert db.get(Publication, other_id).is_active is True


def test_merging_records_with_disagreeing_outcomes_reopens_a_conflict(
    client, db, session_factory, tmp_path, monkeypatch
) -> None:
    csrf, project_id, originals, other_id = _both_screened_pair(
        client, db, session_factory, tmp_path, monkeypatch
    )
    _post(client, csrf, f"{project_id}/duplicates/detect")
    _run_queued_jobs(session_factory)
    db.expire_all()
    candidate = _unresolved_candidate(db)
    kept = originals["Paper 1"]

    merged = _post(
        client, csrf, f"{project_id}/duplicates/{candidate.id}/merge",
        {"canonicalPublicationId": kept},
    )
    assert merged.status_code == 200, merged.json()
    db.expire_all()
    merge = db.scalar(select(PublicationMerge))
    assert merge.outcome_conflict_stages == ["title_abstract"]
    assert valid_final_decision(db, kept, TA) is None
    # Automatic finalization must not quietly re-derive the kept record's own
    # "agreement" over the merged record's disagreeing outcome.
    refresh_automatic_final_decision(db, kept, TA)
    db.commit()
    assert valid_final_decision(db, kept, TA) is None

    conflicts = client.get(
        f"/api/v1/projects/{project_id}/screening/title_abstract/conflicts",
        headers={"X-CSRF-Token": csrf},
    ).json()
    conflict = next(item for item in conflicts if item["publicationId"] == kept)
    assert {d["outcome"] for d in conflict["decisions"]} == {"include"}
    assert {d["outcome"] for d in conflict["mergedDecisions"]} == {"exclude"}

    resolved = _post(
        client, csrf,
        f"{project_id}/screening/title_abstract/publications/{kept}/final",
        {"outcome": "exclude", "resolutionMethod": "manual", "note": None},
    )
    assert resolved.status_code == 200, resolved.json()
    db.expire_all()
    refresh_automatic_final_decision(db, kept, TA)
    db.commit()
    assert valid_final_decision(db, kept, TA).outcome == ScreeningOutcome.EXCLUDE

    # The merged-away record had decisions of its own: undoing this merge
    # needs Move Back, not a standalone undo.
    undo = _post(client, csrf, f"{project_id}/merges/{merge.id}/reverse")
    assert undo.status_code == 409
