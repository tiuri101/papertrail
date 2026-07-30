import pytest
from sqlalchemy import select

from app.accounts.service import create_user
from app.api.errors import DomainError
from app.conflicts.service import record_final_decision
from app.extraction.models import ExtractionResponse, ExtractionWorkItem
from app.extraction.service import (
    claim_next_extraction,
    initialize_extraction,
    submit_extraction,
)
from app.forms.models import FormKind
from app.forms.service import add_field, create_form
from app.projects.models import (
    Project,
    ProjectMembership,
    ProjectStage,
    ReviewType,
    ScreeningStage,
)
from app.publications.models import Publication


def setup_extraction(db):
    create_user(db, "admin", "Admin", "secret-password", is_admin=True)
    r1 = create_user(db, "r1", "R1", "password-1")
    r2 = create_user(db, "r2", "R2", "password-2")
    project = Project(
        name="Review",
        review_type=ReviewType.SYSTEMATIC_REVIEW,
        random_seed="seed",
        stage=ProjectStage.EXTRACTION,
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
    db.commit()
    return project, form, required, optional, publications, r1, r2


def test_initialize_assigns_exactly_one_extractor_per_included_publication(db) -> None:
    project, _, _, _, publications, r1, r2 = setup_extraction(db)
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


def test_next_extraction_endpoint_returns_the_publication_and_active_fields(
    client, db
) -> None:
    project, _, required, optional, publications, r1, _ = setup_extraction(db)
    initialize_extraction(db, project)
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
    assert {field["stableKey"] for field in body["fields"]} == {
        required.stable_key,
        optional.stable_key,
    }
