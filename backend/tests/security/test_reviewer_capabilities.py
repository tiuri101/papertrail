"""Reviewer capabilities must be enforced by the backend on every mutation.

Audit finding: claim-mode queues handed work to any project member, and the
draft/submit/release endpoints only ever checked "is this item assigned to
me?" -- so a member with the stage's capability switched off could claim work
directly through the API, and a reviewer whose capability was revoked after
assignment kept full write access to the items they were holding.
"""

from __future__ import annotations

import pytest
from sqlalchemy import select

from app.api.errors import ForbiddenError
from app.extraction.models import ExtractionStatus, ExtractionWorkItem
from app.extraction.service import (
    claim_next_extraction,
    initialize_extraction,
    submit_extraction,
)
from app.extraction.service import (
    save_draft as save_extraction_draft,
)
from app.projects.models import AllocationMode, ScreeningStage, TaskAllocationMode
from app.quality.models import QualityWorkItem
from app.quality.service import (
    claim_next_quality,
    initialize_quality,
    submit_quality,
)
from app.quality.service import (
    save_draft as save_quality_draft,
)
from app.screening.models import ScreeningWorkItem, WorkItemStatus
from app.screening.service import (
    claim_next_work_item,
    create_screening_work_items,
    release_work_item,
    submit_decision,
)
from app.screening.service import (
    save_draft as save_screening_draft,
)
from tests.security.helpers import (
    OWNER_PASSWORD,
    REVIEWER_PASSWORD,
    build_review_project,
    include_at_full_text,
    login,
)

# --------------------------------------------------------------------------
# Claiming work without the capability
# --------------------------------------------------------------------------


def test_member_without_extract_capability_cannot_claim_extraction(db) -> None:
    fixture = build_review_project(db, can_extract=False, with_extraction_form=True)
    include_at_full_text(db, fixture.publications)
    initialize_extraction(db, fixture.project)
    db.commit()

    with pytest.raises(ForbiddenError):
        claim_next_extraction(db, fixture.project.id, fixture.reviewer.id)


def test_member_without_quality_capability_cannot_claim_quality(db) -> None:
    fixture = build_review_project(db, can_assess_quality=False, with_quality_form=True)
    include_at_full_text(db, fixture.publications)
    initialize_quality(db, fixture.project)
    db.commit()

    with pytest.raises(ForbiddenError):
        claim_next_quality(db, fixture.project.id, fixture.reviewer.id)


def test_member_without_title_abstract_capability_cannot_claim_screening(db) -> None:
    fixture = build_review_project(db, can_title_abstract_screen=False)
    create_screening_work_items(db, fixture.project, ScreeningStage.TITLE_ABSTRACT)
    db.commit()

    with pytest.raises(ForbiddenError):
        claim_next_work_item(
            db,
            fixture.project.id,
            ScreeningStage.TITLE_ABSTRACT,
            fixture.reviewer.id,
        )


def test_member_without_full_text_capability_cannot_claim_screening(db) -> None:
    fixture = build_review_project(db, can_full_text_screen=False)
    create_screening_work_items(db, fixture.project, ScreeningStage.FULL_TEXT)
    db.commit()

    with pytest.raises(ForbiddenError):
        claim_next_work_item(
            db, fixture.project.id, ScreeningStage.FULL_TEXT, fixture.reviewer.id
        )


@pytest.mark.parametrize(
    ("path", "capability"),
    [
        ("extraction/next", "can_extract"),
        ("quality/next", "can_assess_quality"),
        ("screening/title_abstract/next", "can_title_abstract_screen"),
        ("screening/full_text/next", "can_full_text_screen"),
    ],
)
def test_claim_endpoints_reject_a_member_without_the_capability(
    client, db, path, capability
) -> None:
    """The HTTP surface, not just the service, has to refuse the claim."""
    fixture = build_review_project(
        db, with_extraction_form=True, with_quality_form=True
    )
    include_at_full_text(db, fixture.publications)
    initialize_extraction(db, fixture.project)
    initialize_quality(db, fixture.project)
    create_screening_work_items(db, fixture.project, ScreeningStage.TITLE_ABSTRACT)
    create_screening_work_items(db, fixture.project, ScreeningStage.FULL_TEXT)
    db.commit()

    csrf = login(client, fixture.reviewer.username, REVIEWER_PASSWORD)
    response = client.post(
        f"/api/v1/projects/{fixture.project.id}/{path}",
        headers={"X-CSRF-Token": csrf},
    )

    assert response.status_code == 403, response.text
    assert response.json()["error"]["code"] == "forbidden"


# --------------------------------------------------------------------------
# Capability revoked after the work was assigned
# --------------------------------------------------------------------------


def test_revoked_extraction_capability_blocks_draft_submit_and_release(
    client, db
) -> None:
    fixture = build_review_project(
        db, can_extract=True, with_extraction_form=True, publication_count=1
    )
    include_at_full_text(db, fixture.publications)
    initialize_extraction(db, fixture.project)
    db.commit()
    item = claim_next_extraction(db, fixture.project.id, fixture.reviewer.id)
    assert item is not None
    db.commit()

    # The manager turns extraction off while the reviewer is holding the item.
    fixture.membership.can_extract = False
    db.commit()

    assert fixture.extraction_field is not None
    answers = {fixture.extraction_field.stable_key: "Smuggled finding"}
    with pytest.raises(ForbiddenError):
        save_extraction_draft(db, item, fixture.reviewer.id, answers)
    with pytest.raises(ForbiddenError):
        submit_extraction(db, item, fixture.reviewer.id, answers)

    csrf = login(client, fixture.reviewer.username, REVIEWER_PASSWORD)
    base = f"/api/v1/projects/{fixture.project.id}/extraction/{item.id}"
    headers = {"X-CSRF-Token": csrf}
    assert client.put(base + "/draft", json={"draft": answers}, headers=headers).status_code == 403
    assert client.post(base, json={"answers": answers}, headers=headers).status_code == 403
    assert client.post(base + "/release", headers=headers).status_code == 403

    db.refresh(item)
    assert item.status == ExtractionStatus.RESERVED
    assert item.draft == {}


def test_revoked_quality_capability_blocks_draft_submit_and_release(client, db) -> None:
    fixture = build_review_project(
        db, can_assess_quality=True, with_quality_form=True, publication_count=1
    )
    include_at_full_text(db, fixture.publications)
    initialize_quality(db, fixture.project)
    db.commit()
    item = claim_next_quality(db, fixture.project.id, fixture.reviewer.id)
    assert item is not None
    db.commit()

    fixture.membership.can_assess_quality = False
    db.commit()

    assert fixture.quality_field is not None
    answers = {fixture.quality_field.stable_key: "strong"}
    with pytest.raises(ForbiddenError):
        save_quality_draft(db, item, fixture.reviewer.id, answers)
    with pytest.raises(ForbiddenError):
        submit_quality(db, item, fixture.reviewer.id, answers)

    csrf = login(client, fixture.reviewer.username, REVIEWER_PASSWORD)
    base = f"/api/v1/projects/{fixture.project.id}/quality/{item.id}"
    headers = {"X-CSRF-Token": csrf}
    assert client.put(base + "/draft", json={"draft": answers}, headers=headers).status_code == 403
    assert client.post(base, json={"answers": answers}, headers=headers).status_code == 403
    assert client.post(base + "/release", headers=headers).status_code == 403

    db.refresh(item)
    assert item.status != "completed"


def test_revoked_screening_capability_blocks_draft_release_and_decision(
    client, db
) -> None:
    fixture = build_review_project(
        db, can_title_abstract_screen=True, publication_count=1
    )
    create_screening_work_items(db, fixture.project, ScreeningStage.TITLE_ABSTRACT)
    db.commit()
    item = claim_next_work_item(
        db, fixture.project.id, ScreeningStage.TITLE_ABSTRACT, fixture.reviewer.id
    )
    assert item is not None
    db.commit()

    fixture.membership.can_title_abstract_screen = False
    db.commit()

    with pytest.raises(ForbiddenError):
        save_screening_draft(db, item, fixture.reviewer.id, {"note": "still here"})
    with pytest.raises(ForbiddenError):
        release_work_item(db, item, fixture.reviewer.id)
    with pytest.raises(ForbiddenError):
        submit_decision(db, item, fixture.reviewer.id, "include", {}, None)

    csrf = login(client, fixture.reviewer.username, REVIEWER_PASSWORD)
    base = (
        f"/api/v1/projects/{fixture.project.id}/screening/work-items/{item.id}"
    )
    headers = {"X-CSRF-Token": csrf}
    assert client.put(base + "/draft", json={"draft": {}}, headers=headers).status_code == 403
    assert client.post(base + "/release", headers=headers).status_code == 403
    decision = client.post(
        base + "/decision",
        json={"outcome": "include", "criteriaAnswers": {}, "notes": None},
        headers=headers,
    )
    assert decision.status_code == 403

    db.refresh(item)
    assert item.status == WorkItemStatus.RESERVED


def test_manager_reassignment_still_works_after_revoking_a_capability(
    client, db
) -> None:
    """Revocation must not disarm the administrative path that cleans up
    after it -- the manager still has to be able to move the item."""
    fixture = build_review_project(
        db,
        can_title_abstract_screen=True,
        screening_allocation=AllocationMode.DIVIDED,
        publication_count=1,
    )
    create_screening_work_items(db, fixture.project, ScreeningStage.TITLE_ABSTRACT)
    db.commit()
    item = db.scalar(select(ScreeningWorkItem).limit(1))
    assert item is not None

    fixture.membership.can_title_abstract_screen = False
    db.commit()

    csrf = login(client, fixture.owner.username, OWNER_PASSWORD)
    response = client.patch(
        f"/api/v1/projects/{fixture.project.id}/screening/work-items/{item.id}/reassign",
        json={"reviewerId": fixture.owner.id},
        headers={"X-CSRF-Token": csrf},
    )
    assert response.status_code == 200, response.text
    assert response.json()["assignedReviewerId"] == fixture.owner.id


# --------------------------------------------------------------------------
# Eligible reviewers keep working -- both allocation modes
# --------------------------------------------------------------------------


def test_eligible_reviewer_completes_extraction_in_claim_mode(db) -> None:
    fixture = build_review_project(
        db,
        can_extract=True,
        with_extraction_form=True,
        task_allocation=TaskAllocationMode.CLAIM,
        publication_count=1,
    )
    include_at_full_text(db, fixture.publications)
    initialize_extraction(db, fixture.project)
    db.commit()

    item = claim_next_extraction(db, fixture.project.id, fixture.reviewer.id)
    assert item is not None
    assert item.assigned_reviewer_id == fixture.reviewer.id
    assert fixture.extraction_field is not None
    answers = {fixture.extraction_field.stable_key: "A real finding"}
    save_extraction_draft(db, item, fixture.reviewer.id, answers)
    response = submit_extraction(db, item, fixture.reviewer.id, answers)
    db.commit()
    assert response.version == 1
    assert item.status == ExtractionStatus.COMPLETED


def test_eligible_reviewer_completes_extraction_in_pre_assigned_mode(db) -> None:
    fixture = build_review_project(
        db,
        can_extract=True,
        with_extraction_form=True,
        task_allocation=TaskAllocationMode.PRE_ASSIGNED,
        # One publication per eligible extractor (owner, reviewer, admin), so
        # the round-robin pre-assignment is guaranteed to reach our reviewer.
        publication_count=3,
    )
    include_at_full_text(db, fixture.publications)
    initialize_extraction(db, fixture.project)
    db.commit()

    assigned = db.scalars(select(ExtractionWorkItem)).all()
    assert assigned, "pre-assigned mode should create work items up front"
    assert all(
        item.assigned_reviewer_id is not None for item in assigned
    ), "pre-assigned mode should hand every slot to a reviewer up front"

    item = claim_next_extraction(db, fixture.project.id, fixture.reviewer.id)
    assert item is not None
    assert fixture.extraction_field is not None
    answers = {fixture.extraction_field.stable_key: "A real finding"}
    submit_extraction(db, item, fixture.reviewer.id, answers)
    db.commit()
    assert item.status == ExtractionStatus.COMPLETED


def test_eligible_reviewer_completes_quality_assessment(db) -> None:
    fixture = build_review_project(
        db, can_assess_quality=True, with_quality_form=True, publication_count=1
    )
    include_at_full_text(db, fixture.publications)
    initialize_quality(db, fixture.project)
    db.commit()

    item = claim_next_quality(db, fixture.project.id, fixture.reviewer.id)
    assert item is not None
    assert fixture.quality_field is not None
    answers = {fixture.quality_field.stable_key: "strong"}
    save_quality_draft(db, item, fixture.reviewer.id, answers)
    submit_quality(db, item, fixture.reviewer.id, answers)
    db.commit()
    assert db.get(QualityWorkItem, item.id).status == "completed"


@pytest.mark.parametrize(
    "allocation", [AllocationMode.CLAIM, AllocationMode.DIVIDED]
)
def test_eligible_reviewer_completes_screening(db, allocation) -> None:
    fixture = build_review_project(
        db,
        can_title_abstract_screen=True,
        screening_allocation=allocation,
        # One publication per eligible screener (owner, reviewer) so divided
        # allocation reaches our reviewer too.
        publication_count=2,
    )
    create_screening_work_items(db, fixture.project, ScreeningStage.TITLE_ABSTRACT)
    db.commit()

    item = claim_next_work_item(
        db, fixture.project.id, ScreeningStage.TITLE_ABSTRACT, fixture.reviewer.id
    )
    assert item is not None
    save_screening_draft(db, item, fixture.reviewer.id, {"note": "reading"})
    decision = submit_decision(db, item, fixture.reviewer.id, "include", {}, None)
    db.commit()
    assert decision.version == 1
    assert item.status == WorkItemStatus.SUBMITTED
