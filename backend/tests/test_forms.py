from sqlalchemy import select

from app.accounts.service import create_user
from app.audit.models import AuditEvent
from app.forms.models import FieldType, FormField, FormKind, FormVersion, ReviewForm
from app.forms.service import (
    add_field,
    archive_field,
    copy_template_to_project,
    create_form,
    delete_field,
    delete_form,
    rename_field,
    replace_field,
    save_form_as_template,
    update_field,
)
from app.projects.models import Project, ReviewType


def login(client, username: str, password: str) -> str:
    response = client.post(
        "/api/v1/auth/login", json={"username": username, "password": password}
    )
    assert response.status_code == 200
    return response.json()["csrfToken"]


def test_template_copy_is_independent_and_preserves_field_identity(db) -> None:
    project = Project(
        name="Review", review_type=ReviewType.SYSTEMATIC_REVIEW, random_seed="seed"
    )
    db.add(project)
    db.flush()
    template = create_form(
        db, "General extraction", FormKind.EXTRACTION, is_template=True
    )
    field = add_field(db, template, "Main findings", "long_text", required=True)
    db.commit()

    project_form = copy_template_to_project(
        db, template, project.id, "Project extraction"
    )
    db.commit()
    copied = db.scalar(
        select(FormField).where(
            FormField.form_version_id == project_form.active_version_id
        )
    )
    assert copied.stable_key == field.stable_key

    rename_field(db, project_form, copied.stable_key, "Summarized findings")
    db.commit()
    template_field = db.scalar(
        select(FormField).where(FormField.form_version_id == template.active_version_id)
    )
    assert template_field.label == "Main findings"
    project_current = db.scalar(
        select(FormField).where(
            FormField.form_version_id == project_form.active_version_id
        )
    )
    assert project_current.label == "Summarized findings"
    assert project_current.stable_key == field.stable_key


def test_editing_published_form_creates_new_version_and_archives_fields(db) -> None:
    form = create_form(db, "Quality", FormKind.QUALITY, is_template=True)
    first = add_field(
        db,
        form,
        "Study design",
        "single_select",
        required=True,
        options=["Experimental", "Other"],
    )
    first_version_id = form.active_version_id
    db.commit()

    added = add_field(db, form, "Comments", "long_text", required=False)
    db.commit()
    assert form.active_version_id != first_version_id
    assert added.form_version_id == form.active_version_id
    current_fields = list(
        db.scalars(
            select(FormField).where(FormField.form_version_id == form.active_version_id)
        )
    )
    assert {field.label for field in current_fields} == {"Study design", "Comments"}

    archive_field(db, form, first.stable_key)
    db.commit()
    archived = db.scalar(
        select(FormField).where(
            FormField.form_version_id == form.active_version_id,
            FormField.stable_key == first.stable_key,
        )
    )
    assert archived.is_archived is True


def test_save_form_as_template_is_independent_of_the_source_project_form(db) -> None:
    project = Project(
        name="Review", review_type=ReviewType.SYSTEMATIC_REVIEW, random_seed="seed"
    )
    db.add(project)
    db.flush()
    project_form = create_form(
        db, "Project extraction", FormKind.EXTRACTION, project_id=project.id
    )
    field = add_field(db, project_form, "Main findings", "long_text", required=True)
    db.commit()

    template = save_form_as_template(db, project_form, "Reusable extraction")
    db.commit()
    assert template.is_template is True
    assert template.project_id is None
    copied = db.scalar(
        select(FormField).where(FormField.form_version_id == template.active_version_id)
    )
    assert copied.stable_key == field.stable_key
    assert copied.label == "Main findings"

    rename_field(db, project_form, field.stable_key, "Renamed in project")
    db.commit()
    template_field = db.scalar(
        select(FormField).where(FormField.form_version_id == template.active_version_id)
    )
    assert template_field.label == "Main findings"


def test_replace_field_archives_old_field_and_creates_a_new_typed_field(db) -> None:
    form = create_form(db, "Extraction", FormKind.EXTRACTION, is_template=True)
    original = add_field(db, form, "Sample size", "short_text", required=True)
    db.commit()

    replacement = replace_field(
        db, form, original.stable_key, FieldType.NUMBER, label="Sample size"
    )
    db.commit()

    assert replacement.stable_key != original.stable_key
    assert replacement.field_type == FieldType.NUMBER
    current_fields = list(
        db.scalars(
            select(FormField).where(FormField.form_version_id == form.active_version_id)
        )
    )
    fields_by_key = {field.stable_key: field for field in current_fields}
    assert fields_by_key[original.stable_key].is_archived is True
    assert fields_by_key[original.stable_key].field_type == FieldType.SHORT_TEXT
    assert fields_by_key[replacement.stable_key].is_archived is False


def test_update_field_changes_type_and_required_in_place(db) -> None:
    form = create_form(db, "Extraction", FormKind.EXTRACTION, is_template=True)
    field = add_field(db, form, "Sample size", "short_text", required=False)
    db.commit()

    updated = update_field(
        db,
        form,
        field.stable_key,
        label="Sample count",
        field_type="number",
        required=True,
    )
    db.commit()

    assert updated.stable_key == field.stable_key
    assert updated.label == "Sample count"
    assert updated.field_type == FieldType.NUMBER
    assert updated.required is True
    current_fields = list(
        db.scalars(
            select(FormField).where(FormField.form_version_id == form.active_version_id)
        )
    )
    assert len(current_fields) == 1


def test_update_field_changes_options_scoring_and_position(db) -> None:
    form = create_form(db, "Quality", FormKind.QUALITY, is_template=True)
    first = add_field(db, form, "Notes", "long_text")
    second = add_field(
        db,
        form,
        "Study design",
        "single_select",
        options=["Experimental", "Observational"],
    )
    third = add_field(db, form, "Score", "rating", options=["1", "5"])
    db.commit()

    updated = update_field(
        db,
        form,
        second.stable_key,
        options=["Experimental", "Quasi-experimental"],
        scoring={"values": {"Experimental": 2, "Quasi-experimental": 1}},
        position=0,
    )
    db.commit()

    current_fields = list(
        db.scalars(
            select(FormField)
            .where(FormField.form_version_id == form.active_version_id)
            .order_by(FormField.position)
        )
    )
    assert [field.stable_key for field in current_fields] == [
        second.stable_key,
        first.stable_key,
        third.stable_key,
    ]
    assert [field.position for field in current_fields] == [0, 1, 2]
    assert updated.options == ["Experimental", "Quasi-experimental"]
    assert updated.scoring == {"values": {"Experimental": 2, "Quasi-experimental": 1}}


def test_update_field_type_is_blocked_once_responses_exist(db) -> None:
    import pytest

    from app.api.errors import ConflictError
    from app.conflicts.service import record_final_decision
    from app.extraction.service import (
        claim_next_extraction,
        initialize_extraction,
        submit_extraction,
    )
    from app.projects.models import ProjectMembership, ProjectStage, ScreeningStage
    from app.publications.models import Publication

    reviewer = create_user(db, "r2", "R2", "long-password-1")
    project = Project(
        name="Review",
        review_type=ReviewType.SYSTEMATIC_REVIEW,
        random_seed="seed",
        stage=ProjectStage.EXTRACTION,
    )
    db.add(project)
    db.flush()
    db.add(
        ProjectMembership(project_id=project.id, user_id=reviewer.id, can_extract=True)
    )
    form = create_form(db, "Extraction", FormKind.EXTRACTION, project_id=project.id)
    required = add_field(db, form, "Main findings", "long_text", required=True)
    publication = Publication(project_id=project.id, title="Paper")
    db.add(publication)
    db.flush()
    record_final_decision(
        db, publication.id, ScreeningStage.FULL_TEXT, "include", "agreement", None, None
    )
    db.commit()

    initialize_extraction(db, project)
    db.commit()
    item = claim_next_extraction(db, project.id, reviewer.id)
    submit_extraction(db, item, reviewer.id, {required.stable_key: "Finding"})
    db.commit()

    with pytest.raises(ConflictError):
        update_field(db, form, required.stable_key, field_type="number")

    # Label-only and required-only changes remain unaffected by the guard.
    renamed = update_field(db, form, required.stable_key, label="Key findings")
    db.commit()
    assert renamed.label == "Key findings"


def test_marking_a_field_required_reopens_completed_extraction_responses(db) -> None:
    from app.conflicts.service import record_final_decision
    from app.extraction.models import ExtractionStatus, ExtractionWorkItem
    from app.extraction.service import (
        claim_next_extraction,
        initialize_extraction,
        submit_extraction,
    )
    from app.projects.models import ProjectMembership, ProjectStage, ScreeningStage
    from app.publications.models import Publication

    reviewer = create_user(db, "r-extraction", "R Extraction", "long-password-1")
    project = Project(
        name="Review",
        review_type=ReviewType.SYSTEMATIC_REVIEW,
        random_seed="seed",
        stage=ProjectStage.EXTRACTION,
    )
    db.add(project)
    db.flush()
    db.add(
        ProjectMembership(project_id=project.id, user_id=reviewer.id, can_extract=True)
    )
    form = create_form(db, "Extraction", FormKind.EXTRACTION, project_id=project.id)
    optional = add_field(db, form, "Sample size", "short_text", required=False)
    publication = Publication(project_id=project.id, title="Paper")
    db.add(publication)
    db.flush()
    record_final_decision(
        db, publication.id, ScreeningStage.FULL_TEXT, "include", "agreement", None, None
    )
    db.commit()

    initialize_extraction(db, project)
    db.commit()
    item = claim_next_extraction(db, project.id, reviewer.id)
    submit_extraction(db, item, reviewer.id, {optional.stable_key: "12"})
    db.commit()
    item_id = item.id
    assert db.get(ExtractionWorkItem, item_id).status == ExtractionStatus.COMPLETED

    update_field(db, form, optional.stable_key, required=True)
    db.commit()

    reopened = db.get(ExtractionWorkItem, item_id)
    assert reopened.status == ExtractionStatus.AVAILABLE
    assert reopened.completed_at is None


def test_marking_a_field_required_reopens_completed_quality_responses(db) -> None:
    from app.conflicts.service import record_final_decision
    from app.projects.models import ProjectMembership, ProjectStage, ScreeningStage
    from app.publications.models import Publication
    from app.quality.models import QualityConfig, QualityStatus, QualityWorkItem
    from app.quality.service import (
        claim_next_quality,
        initialize_quality,
        submit_quality,
    )

    reviewer = create_user(db, "r-quality", "R Quality", "long-password-1")
    project = Project(
        name="Review",
        review_type=ReviewType.SYSTEMATIC_REVIEW,
        random_seed="seed",
        stage=ProjectStage.EXTRACTION,
    )
    db.add(project)
    db.flush()
    db.add(
        ProjectMembership(
            project_id=project.id, user_id=reviewer.id, can_assess_quality=True
        )
    )
    db.add(QualityConfig(project_id=project.id))
    form = create_form(db, "Quality", FormKind.QUALITY, project_id=project.id)
    optional = add_field(db, form, "Reporting", "rating", required=False)
    publication = Publication(project_id=project.id, title="Paper")
    db.add(publication)
    db.flush()
    record_final_decision(
        db, publication.id, ScreeningStage.FULL_TEXT, "include", "agreement", None, None
    )
    db.commit()

    initialize_quality(db, project)
    db.commit()
    item = claim_next_quality(db, project.id, reviewer.id)
    submit_quality(db, item, reviewer.id, {optional.stable_key: 3})
    db.commit()
    item_id = item.id
    assert db.get(QualityWorkItem, item_id).status == QualityStatus.COMPLETED

    update_field(db, form, optional.stable_key, required=True)
    db.commit()

    reopened = db.get(QualityWorkItem, item_id)
    assert reopened.status == QualityStatus.AVAILABLE
    assert reopened.completed_at is None


def test_delete_field_removes_it_outright(db) -> None:
    form = create_form(db, "Extraction", FormKind.EXTRACTION, is_template=True)
    keep = add_field(db, form, "Main findings", "long_text", required=True)
    drop = add_field(db, form, "Notes", "long_text", required=False)
    db.commit()

    deleted_id = delete_field(db, form, drop.stable_key)
    db.commit()

    assert deleted_id
    current_fields = list(
        db.scalars(
            select(FormField).where(FormField.form_version_id == form.active_version_id)
        )
    )
    assert [field.stable_key for field in current_fields] == [keep.stable_key]


def test_delete_field_is_blocked_once_responses_exist(db) -> None:
    import pytest

    from app.api.errors import ConflictError
    from app.conflicts.service import record_final_decision
    from app.extraction.service import (
        claim_next_extraction,
        initialize_extraction,
        submit_extraction,
    )
    from app.projects.models import ProjectMembership, ProjectStage, ScreeningStage
    from app.publications.models import Publication

    reviewer = create_user(db, "r3", "R3", "long-password-1")
    project = Project(
        name="Review",
        review_type=ReviewType.SYSTEMATIC_REVIEW,
        random_seed="seed",
        stage=ProjectStage.EXTRACTION,
    )
    db.add(project)
    db.flush()
    db.add(
        ProjectMembership(project_id=project.id, user_id=reviewer.id, can_extract=True)
    )
    form = create_form(db, "Extraction", FormKind.EXTRACTION, project_id=project.id)
    required = add_field(db, form, "Main findings", "long_text", required=True)
    publication = Publication(project_id=project.id, title="Paper")
    db.add(publication)
    db.flush()
    record_final_decision(
        db, publication.id, ScreeningStage.FULL_TEXT, "include", "agreement", None, None
    )
    db.commit()

    initialize_extraction(db, project)
    db.commit()
    item = claim_next_extraction(db, project.id, reviewer.id)
    submit_extraction(db, item, reviewer.id, {required.stable_key: "Finding"})
    db.commit()

    with pytest.raises(ConflictError):
        delete_field(db, form, required.stable_key)


def test_delete_form_removes_it_and_its_versions(db) -> None:
    project = Project(
        name="Review", review_type=ReviewType.SYSTEMATIC_REVIEW, random_seed="seed"
    )
    db.add(project)
    db.flush()
    form = create_form(db, "Extraction", FormKind.EXTRACTION, project_id=project.id)
    add_field(db, form, "Main findings", "long_text", required=True)
    db.commit()
    form_id = form.id

    delete_form(db, form)
    db.commit()

    assert db.get(ReviewForm, form_id) is None
    assert db.scalar(select(FormVersion).where(FormVersion.form_id == form_id)) is None


def test_delete_form_is_blocked_once_responses_exist(db) -> None:
    import pytest

    from app.api.errors import ConflictError
    from app.conflicts.service import record_final_decision
    from app.extraction.service import (
        claim_next_extraction,
        initialize_extraction,
        submit_extraction,
    )
    from app.projects.models import ProjectMembership, ProjectStage, ScreeningStage
    from app.publications.models import Publication

    reviewer = create_user(db, "r1", "R1", "long-password-1")
    project = Project(
        name="Review",
        review_type=ReviewType.SYSTEMATIC_REVIEW,
        random_seed="seed",
        stage=ProjectStage.EXTRACTION,
    )
    db.add(project)
    db.flush()
    db.add(
        ProjectMembership(project_id=project.id, user_id=reviewer.id, can_extract=True)
    )
    form = create_form(db, "Extraction", FormKind.EXTRACTION, project_id=project.id)
    required = add_field(db, form, "Main findings", "long_text", required=True)
    publication = Publication(project_id=project.id, title="Paper")
    db.add(publication)
    db.flush()
    record_final_decision(
        db, publication.id, ScreeningStage.FULL_TEXT, "include", "agreement", None, None
    )
    db.commit()

    initialize_extraction(db, project)
    db.commit()
    item = claim_next_extraction(db, project.id, reviewer.id)
    submit_extraction(db, item, reviewer.id, {required.stable_key: "Finding"})
    db.commit()

    with pytest.raises(ConflictError):
        delete_form(db, form)


def test_project_form_creation_rejects_a_second_form_of_the_same_kind(
    client, db
) -> None:
    create_user(db, "admin", "Administrator", "secret-password", is_admin=True)
    db.commit()
    csrf = login(client, "admin", "secret-password")
    project = client.post(
        "/api/v1/projects",
        json={"name": "Review", "reviewType": "systematic_review"},
        headers={"X-CSRF-Token": csrf},
    ).json()
    project_id = project["id"]

    first = client.post(
        f"/api/v1/projects/{project_id}/forms",
        json={"name": "Extraction", "kind": "extraction"},
        headers={"X-CSRF-Token": csrf},
    )
    assert first.status_code == 201

    second = client.post(
        f"/api/v1/projects/{project_id}/forms",
        json={"name": "Another extraction form", "kind": "extraction"},
        headers={"X-CSRF-Token": csrf},
    )
    assert second.status_code == 409
    assert "extraction" in second.json()["error"]["message"]

    other_kind = client.post(
        f"/api/v1/projects/{project_id}/forms",
        json={"name": "Quality", "kind": "quality"},
        headers={"X-CSRF-Token": csrf},
    )
    assert other_kind.status_code == 201


def test_field_updates_and_archiving_record_auditable_changes(client, db) -> None:
    create_user(db, "admin", "Administrator", "secret-password", is_admin=True)
    db.commit()
    csrf = login(client, "admin", "secret-password")
    project_id = client.post(
        "/api/v1/projects",
        json={"name": "Review", "reviewType": "systematic_review"},
        headers={"X-CSRF-Token": csrf},
    ).json()["id"]
    form_id = client.post(
        f"/api/v1/projects/{project_id}/forms",
        json={"name": "Extraction", "kind": "extraction"},
        headers={"X-CSRF-Token": csrf},
    ).json()["id"]
    stable_key = client.post(
        f"/api/v1/forms/{form_id}/fields",
        json={
            "label": "Main finding",
            "fieldType": "short_text",
            "required": False,
        },
        headers={"X-CSRF-Token": csrf},
    ).json()["stableKey"]

    updated = client.patch(
        f"/api/v1/forms/{form_id}/fields/{stable_key}",
        json={
            "label": "Primary outcome",
            "required": True,
        },
        headers={"X-CSRF-Token": csrf},
    )
    assert updated.status_code == 200

    replacement = client.post(
        f"/api/v1/forms/{form_id}/fields/{stable_key}/replace",
        json={
            "label": "Primary outcome",
            "fieldType": "number",
            "required": True,
        },
        headers={"X-CSRF-Token": csrf},
    )
    assert replacement.status_code == 200
    replacement_key = replacement.json()["stableKey"]

    archived = client.patch(
        f"/api/v1/forms/{form_id}/fields/{replacement_key}",
        json={"archive": True},
        headers={"X-CSRF-Token": csrf},
    )
    assert archived.status_code == 200

    events = list(
        db.scalars(
            select(AuditEvent)
            .where(
                AuditEvent.project_id == project_id,
                AuditEvent.action.in_(
                    [
                        "form_field.updated",
                        "form_field.replaced",
                        "form_field.archived",
                    ]
                ),
            )
            .order_by(AuditEvent.created_at, AuditEvent.id)
        )
    )
    assert [event.action for event in events] == [
        "form_field.updated",
        "form_field.replaced",
        "form_field.archived",
    ]
    assert events[0].event_metadata == {
        "stableKey": stable_key,
        "changes": {
            "label": {"from": "Main finding", "to": "Primary outcome"},
            "required": {"from": False, "to": True},
        },
    }
    assert events[1].event_metadata == {
        "replacedStableKey": stable_key,
        "replacementStableKey": replacement_key,
        "changes": {
            "fieldType": {"from": "short_text", "to": "number"},
        },
    }
    assert events[2].event_metadata == {
        "stableKey": replacement_key,
        "changes": {"isArchived": {"from": False, "to": True}},
    }


def test_field_update_api_saves_options_scoring_and_order(client, db) -> None:
    create_user(db, "admin", "Administrator", "secret-password", is_admin=True)
    db.commit()
    csrf = login(client, "admin", "secret-password")
    project_id = client.post(
        "/api/v1/projects",
        json={"name": "Review", "reviewType": "systematic_review"},
        headers={"X-CSRF-Token": csrf},
    ).json()["id"]
    form_id = client.post(
        f"/api/v1/projects/{project_id}/forms",
        json={"name": "Extraction", "kind": "extraction"},
        headers={"X-CSRF-Token": csrf},
    ).json()["id"]
    first_key = client.post(
        f"/api/v1/forms/{form_id}/fields",
        json={
            "label": "Study design",
            "fieldType": "multiple_select",
            "options": ["Experimental", "Observational"],
        },
        headers={"X-CSRF-Token": csrf},
    ).json()["stableKey"]
    second_key = client.post(
        f"/api/v1/forms/{form_id}/fields",
        json={"label": "Notes", "fieldType": "long_text"},
        headers={"X-CSRF-Token": csrf},
    ).json()["stableKey"]

    updated = client.patch(
        f"/api/v1/forms/{form_id}/fields/{first_key}",
        json={
            "position": 1,
            "options": ["Experimental", "Quasi-experimental"],
            "scoring": {"weight": 2},
        },
        headers={"X-CSRF-Token": csrf},
    )

    assert updated.status_code == 200
    assert updated.json()["options"] == ["Experimental", "Quasi-experimental"]
    assert updated.json()["scoring"] == {"weight": 2}
    listed = client.get(f"/api/v1/forms/{form_id}/fields")
    assert [field["stableKey"] for field in listed.json()] == [second_key, first_key]
    assert [field["position"] for field in listed.json()] == [0, 1]


def test_deleting_a_form_allows_recreating_one_of_the_same_kind(client, db) -> None:
    create_user(db, "admin", "Administrator", "secret-password", is_admin=True)
    db.commit()
    csrf = login(client, "admin", "secret-password")
    project = client.post(
        "/api/v1/projects",
        json={"name": "Review", "reviewType": "systematic_review"},
        headers={"X-CSRF-Token": csrf},
    ).json()
    project_id = project["id"]

    first = client.post(
        f"/api/v1/projects/{project_id}/forms",
        json={"name": "Extraction", "kind": "extraction"},
        headers={"X-CSRF-Token": csrf},
    ).json()

    deleted = client.delete(
        f"/api/v1/forms/{first['id']}", headers={"X-CSRF-Token": csrf}
    )
    assert deleted.status_code == 204

    recreated = client.post(
        f"/api/v1/projects/{project_id}/forms",
        json={"name": "Extraction v2", "kind": "extraction"},
        headers={"X-CSRF-Token": csrf},
    )
    assert recreated.status_code == 201

    forms = client.get(f"/api/v1/projects/{project_id}/forms").json()
    assert [form["name"] for form in forms] == ["Extraction v2"]


def test_non_admin_project_owner_can_browse_but_not_manage_templates(
    client, db
) -> None:
    create_user(db, "owner", "Owner", "secret-password", is_admin=False)
    db.commit()
    csrf = login(client, "owner", "secret-password")
    client.post(
        "/api/v1/projects",
        json={"name": "Review", "reviewType": "systematic_review"},
        headers={"X-CSRF-Token": csrf},
    )

    templates = client.get("/api/v1/form-templates")
    assert templates.status_code == 200

    forbidden = client.post(
        "/api/v1/form-templates",
        json={"name": "Template", "kind": "extraction"},
        headers={"X-CSRF-Token": csrf},
    )
    assert forbidden.status_code == 403


def test_administrator_can_inspect_rename_and_remove_a_template(client, db) -> None:
    create_user(db, "admin", "Administrator", "secret-password", is_admin=True)
    template = create_form(
        db, "General extraction", FormKind.EXTRACTION, is_template=True
    )
    add_field(db, template, "Main finding", "long_text", required=True)
    db.commit()
    csrf = login(client, "admin", "secret-password")

    fields = client.get(f"/api/v1/forms/{template.id}/fields")
    assert fields.status_code == 200
    assert fields.json()[0]["label"] == "Main finding"

    renamed = client.patch(
        f"/api/v1/forms/{template.id}",
        json={"name": "Evidence extraction"},
        headers={"X-CSRF-Token": csrf},
    )
    assert renamed.status_code == 200
    assert renamed.json()["name"] == "Evidence extraction"

    removed = client.delete(
        f"/api/v1/forms/{template.id}", headers={"X-CSRF-Token": csrf}
    )
    assert removed.status_code == 204
    assert client.get("/api/v1/form-templates").json() == []
