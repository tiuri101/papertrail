import pytest
from sqlalchemy import select

from app.accounts.service import create_user
from app.api.errors import DomainError, ForbiddenError
from app.audit.models import AuditEvent
from app.conflicts.service import record_final_decision
from app.extraction.models import (
    ExtractionConfig,
    ExtractionResponse,
    ExtractionStatus,
    ExtractionWorkItem,
)
from app.extraction.service import (
    claim_next_extraction,
    initialize_extraction,
    reassign_work_items_from_ineligible_reviewers,
    save_draft,
    submit_extraction,
)
from app.forms.models import FormKind
from app.forms.service import add_field, create_form
from app.fulltext.models import PublicationDocument
from app.projects.models import (
    Project,
    ProjectMembership,
    ProjectStage,
    ReviewType,
    ScreeningStage,
    TaskAllocationMode,
)
from app.publications.models import Publication


def set_pre_assigned(db, project) -> None:
    """Extraction defaults to claim mode; opt a test into pre-assignment when
    that's specifically what it exercises."""
    db.add(
        ExtractionConfig(
            project_id=project.id, allocation_mode=TaskAllocationMode.PRE_ASSIGNED
        )
    )
    db.commit()


def setup_extraction(db):
    create_user(db, "admin", "Admin", "secret-password", is_admin=True)
    r1 = create_user(db, "r1", "R1", "password-1")
    r2 = create_user(db, "r2", "R2", "password-2")
    project = Project(
        name="Review",
        review_type=ReviewType.SYSTEMATIC_REVIEW,
        random_seed="seed",
        # Resolve full-text decisions while still in the full-text stage --
        # matching how the project would actually reach extraction -- so
        # record_final_decision's downstream backfill (for a decision that
        # resolves after the project has *already* moved on) doesn't fire
        # early and race the batch initialize_extraction() call below.
        stage=ProjectStage.FULL_TEXT,
    )
    db.add(project)
    db.flush()
    for reviewer in (r1, r2):
        db.add(
            ProjectMembership(
                project_id=project.id, user_id=reviewer.id, can_extract=True
            )
        )
    form = create_form(db, "Extraction", FormKind.EXTRACTION, project_id=project.id)
    required = add_field(db, form, "Main findings", "long_text", required=True)
    optional = add_field(db, form, "Participants", "number", required=False)
    publications = [
        Publication(project_id=project.id, title=f"Paper {i}") for i in range(3)
    ]
    db.add_all(publications)
    db.flush()
    record_final_decision(
        db,
        publications[0].id,
        ScreeningStage.FULL_TEXT,
        "include",
        "agreement",
        None,
        None,
    )
    record_final_decision(
        db,
        publications[1].id,
        ScreeningStage.FULL_TEXT,
        "include",
        "agreement",
        None,
        None,
    )
    record_final_decision(
        db,
        publications[2].id,
        ScreeningStage.FULL_TEXT,
        "exclude",
        "agreement",
        None,
        None,
    )
    project.stage = ProjectStage.EXTRACTION
    db.commit()
    return project, form, required, optional, publications, r1, r2


def login(client) -> str:
    response = client.post(
        "/api/v1/auth/login",
        json={"username": "admin", "password": "secret-password"},
    )
    return response.json()["csrfToken"]


def test_initialize_assigns_exactly_one_extractor_per_included_publication(db) -> None:
    project, _, _, _, publications, r1, r2 = setup_extraction(db)
    set_pre_assigned(db, project)
    assert initialize_extraction(db, project) == 2
    db.commit()
    items = list(
        db.scalars(select(ExtractionWorkItem).order_by(ExtractionWorkItem.random_rank))
    )
    assert {item.publication_id for item in items} == {
        publications[0].id,
        publications[1].id,
    }
    assert {item.assigned_reviewer_id for item in items} == {r1.id, r2.id}


def test_extraction_validates_required_fields_and_preserves_revisions(db) -> None:
    project, _, required, optional, _, r1, _ = setup_extraction(db)
    initialize_extraction(db, project)
    db.commit()
    item = claim_next_extraction(db, project.id, r1.id)
    assert item is not None
    with pytest.raises(DomainError):
        submit_extraction(db, item, r1.id, {optional.stable_key: 12})
    first = submit_extraction(
        db, item, r1.id, {required.stable_key: "Finding", optional.stable_key: 12}
    )
    second = submit_extraction(db, item, r1.id, {required.stable_key: "Revised"})
    db.commit()
    responses = list(
        db.scalars(
            select(ExtractionResponse)
            .where(ExtractionResponse.work_item_id == item.id)
            .order_by(ExtractionResponse.version)
        )
    )
    assert [response.version for response in responses] == [1, 2]
    assert first.is_current is False
    assert second.is_current is True


def test_owner_can_view_and_override_extraction_with_audit_history(client, db) -> None:
    project, _, required, optional, _, r1, _ = setup_extraction(db)
    initialize_extraction(db, project)
    db.commit()
    item = claim_next_extraction(db, project.id, r1.id)
    assert item is not None
    first = submit_extraction(
        db,
        item,
        r1.id,
        {required.stable_key: "Original finding", optional.stable_key: 12},
    )
    db.commit()
    csrf = login(client)

    details = client.get(
        f"/api/v1/projects/{project.id}/publications/{item.publication_id}/review-details"
    )
    assert details.status_code == 200
    extraction = details.json()["extraction"]
    assert extraction["workItemId"] == item.id
    assert extraction["response"]["version"] == 1
    assert extraction["response"]["reviewerName"] == "R1"
    assert extraction["response"]["answers"][required.stable_key] == "Original finding"

    override = client.post(
        f"/api/v1/projects/{project.id}/extraction/{item.id}/override",
        json={
            "answers": {
                required.stable_key: "Owner-corrected finding",
                optional.stable_key: 12,
            },
            "reason": "Corrected against the source PDF",
        },
        headers={"X-CSRF-Token": csrf},
    )
    assert override.status_code == 200
    assert override.json()["version"] == 2
    db.refresh(first)
    assert first.is_current is False
    audit = db.scalar(
        select(AuditEvent).where(
            AuditEvent.project_id == project.id,
            AuditEvent.action == "extraction.overridden",
        )
    )
    assert audit is not None
    assert audit.event_metadata["previousVersion"] == 1
    assert audit.event_metadata["newVersion"] == 2
    assert required.stable_key in audit.event_metadata["changedFields"]
    assert audit.event_metadata["reason"] == "Corrected against the source PDF"


def test_save_draft_persists_in_progress_answers(db) -> None:
    project, _, required, _, _, r1, r2 = setup_extraction(db)
    initialize_extraction(db, project)
    db.commit()
    item = claim_next_extraction(db, project.id, r1.id)
    assert item is not None

    save_draft(item, r1.id, {required.stable_key: "Draft finding"})
    db.commit()
    db.refresh(item)
    assert item.draft == {required.stable_key: "Draft finding"}

    with pytest.raises(ForbiddenError):
        save_draft(item, r2.id, {required.stable_key: "Not my item"})

    submit_extraction(db, item, r1.id, {required.stable_key: "Final finding"})
    db.commit()
    with pytest.raises(ForbiddenError):
        save_draft(item, r1.id, {required.stable_key: "Too late"})


def test_claim_next_extraction_resumes_reviewers_existing_reservation(db) -> None:
    project, _, _, _, _, r1, _ = setup_extraction(db)
    initialize_extraction(db, project)
    db.commit()

    first = claim_next_extraction(db, project.id, r1.id)
    assert first is not None
    first_reservation = first.reserved_until
    db.commit()

    resumed = claim_next_extraction(db, project.id, r1.id)

    assert resumed is not None
    assert resumed.id == first.id
    assert resumed.status == ExtractionStatus.RESERVED
    assert resumed.reserved_until is not None
    assert first_reservation is not None
    assert resumed.reserved_until >= first_reservation


def test_new_required_field_reopens_completed_extractions(db) -> None:
    project, form, required, _, _, r1, _ = setup_extraction(db)
    initialize_extraction(db, project)
    db.commit()
    item = claim_next_extraction(db, project.id, r1.id)
    submit_extraction(db, item, r1.id, {required.stable_key: "Finding"})
    db.commit()
    assert item.status == "completed"
    add_field(db, form, "Limitations", "long_text", required=True)
    db.commit()
    db.refresh(item)
    assert item.status == "available"


def test_removing_a_reviewer_reassigns_their_pending_extraction_items(
    client, db
) -> None:
    project, _, _, _, _, r1, r2 = setup_extraction(db)
    set_pre_assigned(db, project)
    initialize_extraction(db, project)
    db.commit()
    membership2 = db.scalar(
        select(ProjectMembership).where(
            ProjectMembership.project_id == project.id,
            ProjectMembership.user_id == r2.id,
        )
    )

    login = client.post(
        "/api/v1/auth/login", json={"username": "admin", "password": "secret-password"}
    )
    csrf = login.json()["csrfToken"]
    response = client.delete(
        f"/api/v1/projects/{project.id}/members/{membership2.id}",
        headers={"X-CSRF-Token": csrf},
    )
    assert response.status_code == 204

    items = list(
        db.scalars(
            select(ExtractionWorkItem).where(
                ExtractionWorkItem.project_id == project.id
            )
        )
    )
    assert r2.id not in {item.assigned_reviewer_id for item in items}
    assert all(item.status == ExtractionStatus.AVAILABLE for item in items)


def test_revoking_extraction_permission_reassigns_work_items(client, db) -> None:
    project, _, _, _, _, r1, r2 = setup_extraction(db)
    set_pre_assigned(db, project)
    initialize_extraction(db, project)
    db.commit()
    membership2 = db.scalar(
        select(ProjectMembership).where(
            ProjectMembership.project_id == project.id,
            ProjectMembership.user_id == r2.id,
        )
    )

    login = client.post(
        "/api/v1/auth/login", json={"username": "admin", "password": "secret-password"}
    )
    csrf = login.json()["csrfToken"]
    response = client.patch(
        f"/api/v1/projects/{project.id}/members/{membership2.id}",
        json={"canExtract": False},
        headers={"X-CSRF-Token": csrf},
    )
    assert response.status_code == 200

    items = list(
        db.scalars(
            select(ExtractionWorkItem).where(
                ExtractionWorkItem.project_id == project.id
            )
        )
    )
    assert r2.id not in {item.assigned_reviewer_id for item in items}


def test_completed_extraction_items_are_not_reassigned(db) -> None:
    project, _, required, _, _, r1, r2 = setup_extraction(db)
    set_pre_assigned(db, project)
    initialize_extraction(db, project)
    db.commit()
    r2_item = next(
        item
        for item in db.scalars(
            select(ExtractionWorkItem).where(
                ExtractionWorkItem.project_id == project.id,
                ExtractionWorkItem.assigned_reviewer_id == r2.id,
            )
        )
    )
    submit_extraction(db, r2_item, r2.id, {required.stable_key: "Finding"})
    db.commit()

    membership2 = db.scalar(
        select(ProjectMembership).where(
            ProjectMembership.project_id == project.id,
            ProjectMembership.user_id == r2.id,
        )
    )
    db.delete(membership2)
    db.commit()

    reassigned = reassign_work_items_from_ineligible_reviewers(db, project.id)
    db.commit()

    assert reassigned == 0
    db.refresh(r2_item)
    assert r2_item.assigned_reviewer_id == r2.id
    assert r2_item.status == ExtractionStatus.COMPLETED


def test_next_extraction_endpoint_returns_the_publication_and_active_fields(
    client, db
) -> None:
    project, _, required, optional, publications, r1, _ = setup_extraction(db)
    set_pre_assigned(db, project)
    initialize_extraction(db, project)
    assigned_item = db.scalar(
        select(ExtractionWorkItem).where(
            ExtractionWorkItem.project_id == project.id,
            ExtractionWorkItem.assigned_reviewer_id == r1.id,
        )
    )
    assert assigned_item is not None
    db.add(
        PublicationDocument(
            project_id=project.id,
            publication_id=assigned_item.publication_id,
            original_filename="paper.pdf",
            storage_key=f"projects/{project.id}/publications/{assigned_item.publication_id}/document.pdf",
            mime_type="application/pdf",
            file_size=1024,
            sha256="a" * 64,
            uploaded_by_user_id=r1.id,
        )
    )
    db.commit()
    csrf = client.post(
        "/api/v1/auth/login", json={"username": "r1", "password": "password-1"}
    ).json()["csrfToken"]

    response = client.post(
        f"/api/v1/projects/{project.id}/extraction/next", headers={"X-CSRF-Token": csrf}
    )
    assert response.status_code == 200
    body = response.json()
    assert body["publication"]["title"] in {"Paper 0", "Paper 1"}
    assert body["fullTextAvailable"] is True
    assert "storage" not in str(body).lower()
    assert {field["stableKey"] for field in body["fields"]} == {
        required.stable_key,
        optional.stable_key,
    }

    resumed_response = client.post(
        f"/api/v1/projects/{project.id}/extraction/next",
        headers={"X-CSRF-Token": csrf},
    )
    assert resumed_response.status_code == 200
    assert resumed_response.json()["id"] == body["id"]


def test_progress_endpoint_reports_assigned_and_completed_counts(client, db) -> None:
    project, _, required, _, _, r1, _ = setup_extraction(db)
    set_pre_assigned(db, project)
    initialize_extraction(db, project)
    db.commit()
    csrf = client.post(
        "/api/v1/auth/login", json={"username": "r1", "password": "password-1"}
    ).json()["csrfToken"]

    before = client.get(
        f"/api/v1/projects/{project.id}/extraction/progress",
        headers={"X-CSRF-Token": csrf},
    )
    assert before.status_code == 200
    assert before.json() == {
        "assigned": 1,
        "completed": 0,
        "remaining": 0,
        "claimMode": False,
    }

    item = claim_next_extraction(db, project.id, r1.id)
    submit_extraction(db, item, r1.id, {required.stable_key: "Finding"})
    db.commit()

    after = client.get(
        f"/api/v1/projects/{project.id}/extraction/progress",
        headers={"X-CSRF-Token": csrf},
    )
    assert after.status_code == 200
    assert after.json() == {
        "assigned": 1,
        "completed": 1,
        "remaining": 0,
        "claimMode": False,
    }


def test_progress_endpoint_reports_remaining_in_claim_mode(client, db) -> None:
    project, _, required, _, _, r1, _ = setup_extraction(db)
    initialize_extraction(db, project)
    db.commit()
    csrf = client.post(
        "/api/v1/auth/login", json={"username": "r1", "password": "password-1"}
    ).json()["csrfToken"]

    before = client.get(
        f"/api/v1/projects/{project.id}/extraction/progress",
        headers={"X-CSRF-Token": csrf},
    )
    assert before.status_code == 200
    assert before.json() == {
        "assigned": 0,
        "completed": 0,
        "remaining": 2,
        "claimMode": True,
    }

    item = claim_next_extraction(db, project.id, r1.id)
    submit_extraction(db, item, r1.id, {required.stable_key: "Finding"})
    db.commit()

    after = client.get(
        f"/api/v1/projects/{project.id}/extraction/progress",
        headers={"X-CSRF-Token": csrf},
    )
    assert after.status_code == 200
    assert after.json() == {
        "assigned": 1,
        "completed": 1,
        "remaining": 1,
        "claimMode": True,
    }


def test_mine_endpoint_lists_only_the_callers_completed_extractions(client, db) -> None:
    project, _, required, _, _, r1, r2 = setup_extraction(db)
    initialize_extraction(db, project)
    db.commit()
    item = claim_next_extraction(db, project.id, r1.id)
    submit_extraction(db, item, r1.id, {required.stable_key: "Finding"})
    db.commit()

    csrf = client.post(
        "/api/v1/auth/login", json={"username": "r1", "password": "password-1"}
    ).json()["csrfToken"]
    mine = client.get(
        f"/api/v1/projects/{project.id}/extraction/mine",
        headers={"X-CSRF-Token": csrf},
    )
    assert mine.status_code == 200
    body = mine.json()
    assert len(body) == 1
    assert body[0]["id"] == item.id
    assert body[0]["version"] == 1

    other_csrf = client.post(
        "/api/v1/auth/login", json={"username": "r2", "password": "password-2"}
    ).json()["csrfToken"]
    other_mine = client.get(
        f"/api/v1/projects/{project.id}/extraction/mine",
        headers={"X-CSRF-Token": other_csrf},
    )
    assert other_mine.status_code == 200
    assert other_mine.json() == []


def test_completed_extraction_can_be_revisited_and_resubmitted(client, db) -> None:
    project, _, required, _, _, r1, r2 = setup_extraction(db)
    initialize_extraction(db, project)
    db.commit()
    item = claim_next_extraction(db, project.id, r1.id)
    submit_extraction(db, item, r1.id, {required.stable_key: "Finding"})
    db.commit()

    csrf = client.post(
        "/api/v1/auth/login", json={"username": "r1", "password": "password-1"}
    ).json()["csrfToken"]
    fetched = client.get(
        f"/api/v1/projects/{project.id}/extraction/{item.id}",
        headers={"X-CSRF-Token": csrf},
    )
    assert fetched.status_code == 200
    assert fetched.json()["currentResponse"]["answers"] == {
        required.stable_key: "Finding"
    }

    corrected = client.post(
        f"/api/v1/projects/{project.id}/extraction/{item.id}",
        json={"answers": {required.stable_key: "Corrected finding"}},
        headers={"X-CSRF-Token": csrf},
    )
    assert corrected.status_code == 200
    assert corrected.json()["version"] == 2

    other_csrf = client.post(
        "/api/v1/auth/login", json={"username": "r2", "password": "password-2"}
    ).json()["csrfToken"]
    forbidden = client.get(
        f"/api/v1/projects/{project.id}/extraction/{item.id}",
        headers={"X-CSRF-Token": other_csrf},
    )
    assert forbidden.status_code == 403
