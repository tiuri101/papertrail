"""Unit tests for the shared review-work allocation/progress primitives used
by both extraction and quality (see app/review_work/). Domain-level coverage
already exists in test_extraction.py/test_quality.py exercising these through
the real services; these tests pin the shared implementation itself."""

from __future__ import annotations

from app.accounts.models import User
from app.extraction.models import ExtractionStatus, ExtractionWorkItem
from app.forms.models import FormKind, FormVersion, ReviewForm
from app.projects.models import Project, ReviewType
from app.publications.models import Publication
from app.review_work.allocation import reassign_orphaned_items, rebalance_pending_items
from app.review_work.progress import (
    completed_items_with_response,
    remaining_claimable_items,
    reviewer_progress,
)


def _make_project(db) -> Project:
    project = Project(
        name="Shared Review Work",
        review_type=ReviewType.SYSTEMATIC_REVIEW,
        random_seed="seed",
    )
    db.add(project)
    db.flush()
    return project


def _make_publication(db, project: Project, title: str = "A study") -> Publication:
    publication = Publication(project_id=project.id, title=title)
    db.add(publication)
    db.flush()
    return publication


def _make_user(db, user_id: str, *, is_admin: bool = False) -> User:
    user = User(
        id=user_id,
        username=user_id,
        display_name=user_id,
        email=f"{user_id}@example.com",
        password_hash="hash",
        is_admin=is_admin,
    )
    db.add(user)
    db.flush()
    return user


def _make_form_version(db, project: Project) -> FormVersion:
    form = ReviewForm(
        project_id=project.id,
        name="Extraction form",
        kind=FormKind.EXTRACTION,
        is_template=False,
    )
    version = FormVersion(form=form, version_number=1, change_summary=None, is_published=True)
    db.add(version)
    db.flush()
    return version


def test_reassign_orphaned_items_releases_to_open_pool_in_claim_mode(db) -> None:
    project = _make_project(db)
    _make_user(db, "departed-reviewer")
    _make_user(db, "current-reviewer")
    publication = _make_publication(db, project)
    item = ExtractionWorkItem(
        project_id=project.id,
        publication_id=publication.id,
        slot_number=1,
        assigned_reviewer_id="departed-reviewer",
        status=ExtractionStatus.RESERVED,
        random_rank="a",
    )
    db.add(item)
    db.flush()

    reassigned = reassign_orphaned_items(
        db,
        ExtractionWorkItem,
        project_id=project.id,
        eligible=["current-reviewer"],
        claim_mode=True,
        completed_status=ExtractionStatus.COMPLETED,
        available_status=ExtractionStatus.AVAILABLE,
    )

    assert reassigned == 1
    assert item.assigned_reviewer_id is None
    assert item.status == ExtractionStatus.AVAILABLE
    assert item.reserved_until is None


def test_reassign_orphaned_items_round_robins_in_pre_assigned_mode(db) -> None:
    project = _make_project(db)
    _make_user(db, "departed-reviewer")
    _make_user(db, "reviewer-a")
    _make_user(db, "reviewer-b")
    items = []
    for index in range(3):
        publication = _make_publication(db, project, title=f"Study {index}")
        item = ExtractionWorkItem(
            project_id=project.id,
            publication_id=publication.id,
            slot_number=1,
            assigned_reviewer_id="departed-reviewer",
            status=ExtractionStatus.AVAILABLE,
            random_rank=str(index),
        )
        db.add(item)
        items.append(item)
    db.flush()

    reassigned = reassign_orphaned_items(
        db,
        ExtractionWorkItem,
        project_id=project.id,
        eligible=["reviewer-a", "reviewer-b"],
        claim_mode=False,
        completed_status=ExtractionStatus.COMPLETED,
        available_status=ExtractionStatus.AVAILABLE,
    )

    assert reassigned == 3
    assert [item.assigned_reviewer_id for item in items] == [
        "reviewer-a",
        "reviewer-b",
        "reviewer-a",
    ]


def test_reassign_orphaned_items_never_touches_completed_items(db) -> None:
    project = _make_project(db)
    _make_user(db, "departed-reviewer")
    _make_user(db, "current-reviewer")
    publication = _make_publication(db, project)
    item = ExtractionWorkItem(
        project_id=project.id,
        publication_id=publication.id,
        slot_number=1,
        assigned_reviewer_id="departed-reviewer",
        status=ExtractionStatus.COMPLETED,
        random_rank="a",
    )
    db.add(item)
    db.flush()

    reassigned = reassign_orphaned_items(
        db,
        ExtractionWorkItem,
        project_id=project.id,
        eligible=["current-reviewer"],
        claim_mode=True,
        completed_status=ExtractionStatus.COMPLETED,
        available_status=ExtractionStatus.AVAILABLE,
    )

    assert reassigned == 0
    assert item.assigned_reviewer_id == "departed-reviewer"
    assert item.status == ExtractionStatus.COMPLETED


def test_rebalance_pending_items_spreads_load_by_weight(db) -> None:
    project = _make_project(db)
    _make_user(db, "reviewer-a")
    _make_user(db, "reviewer-b")
    pending_items = []
    for index in range(4):
        publication = _make_publication(db, project, title=f"Pending {index}")
        item = ExtractionWorkItem(
            project_id=project.id,
            publication_id=publication.id,
            slot_number=1,
            assigned_reviewer_id=None,
            status=ExtractionStatus.AVAILABLE,
            random_rank=str(index),
        )
        db.add(item)
        pending_items.append(item)
    db.flush()

    reassigned = rebalance_pending_items(
        db,
        ExtractionWorkItem,
        project_id=project.id,
        eligible=["reviewer-a", "reviewer-b"],
        weights={"reviewer-a": 1.0, "reviewer-b": 1.0},
        available_status=ExtractionStatus.AVAILABLE,
    )

    assert reassigned == 4
    counts: dict[str, int] = {}
    for item in pending_items:
        counts[item.assigned_reviewer_id] = counts.get(item.assigned_reviewer_id, 0) + 1
    assert counts == {"reviewer-a": 2, "reviewer-b": 2}


def test_remaining_claimable_items_counts_own_and_unclaimed(db) -> None:
    project = _make_project(db)
    _make_user(db, "me")
    _make_user(db, "someone-else")
    own_pub = _make_publication(db, project, title="Own")
    unclaimed_pub = _make_publication(db, project, title="Unclaimed")
    other_pub = _make_publication(db, project, title="Someone else's")
    db.add_all(
        [
            ExtractionWorkItem(
                project_id=project.id,
                publication_id=own_pub.id,
                slot_number=1,
                assigned_reviewer_id="me",
                status=ExtractionStatus.RESERVED,
                random_rank="a",
            ),
            ExtractionWorkItem(
                project_id=project.id,
                publication_id=unclaimed_pub.id,
                slot_number=1,
                assigned_reviewer_id=None,
                status=ExtractionStatus.AVAILABLE,
                random_rank="b",
            ),
            ExtractionWorkItem(
                project_id=project.id,
                publication_id=other_pub.id,
                slot_number=1,
                assigned_reviewer_id="someone-else",
                status=ExtractionStatus.RESERVED,
                random_rank="c",
            ),
        ]
    )
    db.flush()

    remaining = remaining_claimable_items(
        db,
        ExtractionWorkItem,
        project_id=project.id,
        reviewer_id="me",
        completed_status=ExtractionStatus.COMPLETED,
    )

    assert remaining == 2


def test_reviewer_progress_reports_zero_remaining_outside_claim_mode(db) -> None:
    project = _make_project(db)
    _make_user(db, "me")
    publication = _make_publication(db, project)
    db.add(
        ExtractionWorkItem(
            project_id=project.id,
            publication_id=publication.id,
            slot_number=1,
            assigned_reviewer_id="me",
            status=ExtractionStatus.COMPLETED,
            random_rank="a",
        )
    )
    db.flush()

    progress = reviewer_progress(
        db,
        ExtractionWorkItem,
        project_id=project.id,
        reviewer_id="me",
        completed_status=ExtractionStatus.COMPLETED,
        claim_mode=False,
        remaining=99,
    )

    assert progress == {
        "assigned": 1,
        "completed": 1,
        "remaining": 0,
        "claim_mode": False,
    }


def test_completed_items_with_response_pairs_current_response_only(db) -> None:
    from app.extraction.models import ExtractionResponse

    project = _make_project(db)
    _make_user(db, "me")
    form_version = _make_form_version(db, project)
    publication = _make_publication(db, project)
    item = ExtractionWorkItem(
        project_id=project.id,
        publication_id=publication.id,
        slot_number=1,
        assigned_reviewer_id="me",
        status=ExtractionStatus.COMPLETED,
        random_rank="a",
    )
    db.add(item)
    db.flush()
    stale = ExtractionResponse(
        work_item_id=item.id,
        reviewer_id="me",
        form_version_id=form_version.id,
        answers={"old": True},
        version=1,
        is_current=False,
    )
    current = ExtractionResponse(
        work_item_id=item.id,
        reviewer_id="me",
        form_version_id=form_version.id,
        answers={"new": True},
        version=2,
        is_current=True,
    )
    db.add_all([stale, current])
    db.flush()

    pairs = completed_items_with_response(
        db,
        ExtractionWorkItem,
        ExtractionResponse,
        project_id=project.id,
        reviewer_id="me",
        completed_status=ExtractionStatus.COMPLETED,
    )

    assert len(pairs) == 1
    paired_item, paired_response = pairs[0]
    assert paired_item.id == item.id
    assert paired_response.id == current.id
