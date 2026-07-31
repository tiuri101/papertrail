from sqlalchemy import select

from app.accounts.service import create_user
from app.forms.models import FieldType, FormField, FormKind
from app.forms.service import (
    add_field,
    archive_field,
    copy_template_to_project,
    create_form,
    rename_field,
    replace_field,
    save_form_as_template,
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


def test_project_form_creation_rejects_a_second_form_of_the_same_kind(client, db) -> None:
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
