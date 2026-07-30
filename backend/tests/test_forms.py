from sqlalchemy import select

from app.forms.models import FormField, FormKind
from app.forms.service import (
    add_field,
    archive_field,
    copy_template_to_project,
    create_form,
    rename_field,
)
from app.projects.models import Project, ReviewType


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
