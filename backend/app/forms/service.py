from __future__ import annotations

from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.errors import ConflictError, DomainError, NotFoundError
from app.forms.models import FieldType, FormField, FormKind, FormVersion, ReviewForm


def active_fields(db: Session, form: ReviewForm) -> list[FormField]:
    """The non-archived fields of a form's active version, in display order.
    Canonical query for "what fields does a reviewer actually see" -- used by
    extraction, quality, and LLM schema management alike."""
    return list(
        db.scalars(
            select(FormField)
            .where(
                FormField.form_version_id == form.active_version_id,
                FormField.is_archived.is_(False),
            )
            .order_by(FormField.position)
        )
    )


def project_form_by_kind(
    db: Session, project_id: str, kind: FormKind
) -> ReviewForm | None:
    """The project's form of a given kind, if one has been created.

    Canonical lookup for "does this project have a form of kind X" -- extraction,
    quality, and LLM schema management all need this same query.
    """
    return db.scalar(
        select(ReviewForm).where(
            ReviewForm.project_id == project_id, ReviewForm.kind == kind
        )
    )


def create_form(
    db: Session,
    name: str,
    kind: FormKind,
    *,
    is_template: bool = False,
    project_id: str | None = None,
) -> ReviewForm:
    if is_template and project_id is not None:
        raise ConflictError(
            "A form cannot be both a global template and project-specific"
        )
    form = ReviewForm(
        name=name.strip(), kind=kind, is_template=is_template, project_id=project_id
    )
    db.add(form)
    db.flush()
    version = FormVersion(
        form_id=form.id, version_number=1, change_summary="Initial form"
    )
    db.add(version)
    db.flush()
    form.active_version_id = version.id
    db.flush()
    return form


def active_version(db: Session, form: ReviewForm) -> FormVersion:
    if not form.active_version_id:
        raise NotFoundError("Form has no active version")
    version = db.get(FormVersion, form.active_version_id)
    if version is None:
        raise NotFoundError("Active form version not found")
    return version


def fork_version(db: Session, form: ReviewForm, summary: str) -> FormVersion:
    current = active_version(db, form)
    next_number = (
        int(
            db.scalar(
                select(func.max(FormVersion.version_number)).where(
                    FormVersion.form_id == form.id
                )
            )
            or 0
        )
        + 1
    )
    new_version = FormVersion(
        form_id=form.id, version_number=next_number, change_summary=summary
    )
    db.add(new_version)
    db.flush()
    for field in list(
        db.scalars(
            select(FormField)
            .where(FormField.form_version_id == current.id)
            .order_by(FormField.position)
        )
    ):
        db.add(
            FormField(
                form_version_id=new_version.id,
                stable_key=field.stable_key,
                label=field.label,
                field_type=field.field_type,
                required=field.required,
                position=field.position,
                options=list(field.options),
                scoring=dict(field.scoring),
                is_archived=field.is_archived,
            )
        )
    form.active_version_id = new_version.id
    db.flush()
    return new_version


def editable_version(db: Session, form: ReviewForm, summary: str) -> FormVersion:
    current = active_version(db, form)
    has_fields = (
        db.scalar(
            select(func.count())
            .select_from(FormField)
            .where(FormField.form_version_id == current.id)
        )
        or 0
    )
    return fork_version(db, form, summary) if has_fields else current


def add_field(
    db: Session,
    form: ReviewForm,
    label: str,
    field_type: str | FieldType,
    *,
    required: bool = False,
    options: list[Any] | None = None,
    scoring: dict[str, Any] | None = None,
) -> FormField:
    version = editable_version(db, form, f"Added field: {label}")
    position = int(
        db.scalar(
            select(func.coalesce(func.max(FormField.position), -1) + 1).where(
                FormField.form_version_id == version.id
            )
        )
        or 0
    )
    field = FormField(
        form_version_id=version.id,
        label=label.strip(),
        field_type=FieldType(field_type),
        required=required,
        position=position,
        options=options or [],
        scoring=scoring or {},
    )
    db.add(field)
    db.flush()
    if required and form.project_id is not None:
        if form.kind == FormKind.EXTRACTION:
            from app.extraction.service import reopen_for_required_field

            reopen_for_required_field(db, form.project_id)
        elif form.kind == FormKind.QUALITY:
            try:
                from app.quality.service import (
                    reopen_for_required_field as reopen_quality,
                )

                reopen_quality(db, form.project_id)
            except ImportError:
                pass
    return field


def find_field(db: Session, version: FormVersion, stable_key: str) -> FormField:
    field = db.scalar(
        select(FormField).where(
            FormField.form_version_id == version.id,
            FormField.stable_key == stable_key,
        )
    )
    if field is None:
        raise NotFoundError("Form field not found")
    return field


def rename_field(
    db: Session, form: ReviewForm, stable_key: str, label: str
) -> FormField:
    version = fork_version(db, form, f"Renamed field to: {label}")
    field = find_field(db, version, stable_key)
    field.label = label.strip()
    db.flush()
    return field


def archive_field(db: Session, form: ReviewForm, stable_key: str) -> FormField:
    version = fork_version(db, form, "Archived field")
    field = find_field(db, version, stable_key)
    field.is_archived = True
    db.flush()
    return field


def _has_recorded_responses(db: Session, form: ReviewForm) -> bool:
    version_ids = list(
        db.scalars(select(FormVersion.id).where(FormVersion.form_id == form.id))
    )
    if not version_ids:
        return False
    from app.extraction.models import ExtractionResponse
    from app.quality.models import QualityResponse

    has_extraction_responses = db.scalar(
        select(func.count())
        .select_from(ExtractionResponse)
        .where(ExtractionResponse.form_version_id.in_(version_ids))
    )
    has_quality_responses = db.scalar(
        select(func.count())
        .select_from(QualityResponse)
        .where(QualityResponse.form_version_id.in_(version_ids))
    )
    return bool(has_extraction_responses or has_quality_responses)


def update_field(
    db: Session,
    form: ReviewForm,
    stable_key: str,
    *,
    label: str | None = None,
    field_type: str | FieldType | None = None,
    required: bool | None = None,
    position: int | None = None,
    options: list[Any] | None = None,
    scoring: dict[str, Any] | None = None,
) -> FormField:
    """Change a field's editable configuration in a new form version.

    Unlike ``replace_field``, this mutates the field directly instead of
    archiving it and adding a replacement -- only safe while the form has no
    recorded responses yet (e.g. while still being drafted in the setup
    wizard), since there are no existing answers whose type could be
    invalidated by the change.
    """
    if field_type is not None and _has_recorded_responses(db, form):
        raise ConflictError(
            "This form already has recorded reviewer responses, so a field's "
            "type can't be changed in place. Replace the field instead."
        )
    version = fork_version(db, form, "Updated field")
    field = find_field(db, version, stable_key)
    if label is not None:
        field.label = label.strip()
    if field_type is not None:
        field.field_type = FieldType(field_type)
    if required is not None:
        field.required = required
    if options is not None:
        field.options = list(options)
    if scoring is not None:
        field.scoring = dict(scoring)
    if position is not None:
        _set_field_position(db, version, stable_key, position)
    db.flush()
    if field.required and form.project_id is not None:
        if form.kind == FormKind.EXTRACTION:
            from app.extraction.service import reopen_for_required_field

            reopen_for_required_field(db, form.project_id)
        elif form.kind == FormKind.QUALITY:
            try:
                from app.quality.service import (
                    reopen_for_required_field as reopen_quality,
                )

                reopen_quality(db, form.project_id)
            except ImportError:
                pass
    return field


def delete_field(db: Session, form: ReviewForm, stable_key: str) -> str:
    """Remove a field outright, provided no reviewer responses depend on it.

    Intended for forms still being drafted (e.g. in the setup wizard), where
    there's no recorded data to preserve -- once responses exist,
    ``archive_field`` should be used instead so recorded values stay intact.
    """
    if _has_recorded_responses(db, form):
        raise ConflictError(
            "This form already has recorded reviewer responses and fields "
            "can't be removed outright. Archive the field instead."
        )
    version = fork_version(db, form, "Removed field")
    field = find_field(db, version, stable_key)
    field_id = field.id
    db.delete(field)
    db.flush()
    return field_id


def replace_field(
    db: Session,
    form: ReviewForm,
    stable_key: str,
    field_type: str | FieldType,
    *,
    label: str | None = None,
    required: bool = False,
    position: int | None = None,
    options: list[Any] | None = None,
    scoring: dict[str, Any] | None = None,
) -> FormField:
    """Archive a field and add its replacement in a single new version.

    Per the spec, changing a field's type after values exist requires an
    explicit migration or replacement field rather than an in-place type
    mutation -- so this creates a distinct field with a new stable_key,
    leaving historical responses keyed to the old stable_key intact and
    interpretable under their original type.
    """
    version = fork_version(db, form, "Replaced field")
    old_field = find_field(db, version, stable_key)
    old_field.is_archived = True
    new_field = FormField(
        form_version_id=version.id,
        label=(label or old_field.label).strip(),
        field_type=FieldType(field_type),
        required=required,
        position=old_field.position,
        options=options or [],
        scoring=scoring or {},
    )
    db.add(new_field)
    db.flush()
    if position is not None:
        _set_field_position(db, version, new_field.stable_key, position)
    if required and form.project_id is not None:
        if form.kind == FormKind.EXTRACTION:
            from app.extraction.service import reopen_for_required_field

            reopen_for_required_field(db, form.project_id)
        elif form.kind == FormKind.QUALITY:
            try:
                from app.quality.service import (
                    reopen_for_required_field as reopen_quality,
                )

                reopen_quality(db, form.project_id)
            except ImportError:
                pass
    return new_field


def _set_field_position(
    db: Session,
    version: FormVersion,
    stable_key: str,
    position: int,
) -> None:
    """Move a field to an absolute index and normalize every field position."""
    fields = list(
        db.scalars(
            select(FormField)
            .where(FormField.form_version_id == version.id)
            .order_by(FormField.position, FormField.created_at, FormField.id)
        )
    )
    moving = next((field for field in fields if field.stable_key == stable_key), None)
    if moving is None:
        raise NotFoundError("Form field not found")
    if position >= len(fields):
        raise DomainError("Form field position is outside the form")
    fields.remove(moving)
    fields.insert(position, moving)
    for index, field in enumerate(fields):
        field.position = index


def save_form_as_template(
    db: Session,
    form: ReviewForm,
    name: str | None = None,
) -> ReviewForm:
    """Save a project form's active fields as a new reusable template.

    Deep-copies fields into a brand-new template form, independent of the
    source project form from that point on -- mirrors
    ``copy_template_to_project`` in the opposite direction.
    """
    if form.is_template:
        raise ConflictError("Form is already a template")
    template = create_form(db, name or form.name, form.kind, is_template=True)
    version = active_version(db, template)
    source = active_version(db, form)
    for field in list(
        db.scalars(
            select(FormField)
            .where(
                FormField.form_version_id == source.id, FormField.is_archived.is_(False)
            )
            .order_by(FormField.position)
        )
    ):
        db.add(
            FormField(
                form_version_id=version.id,
                stable_key=field.stable_key,
                label=field.label,
                field_type=field.field_type,
                required=field.required,
                position=field.position,
                options=list(field.options),
                scoring=dict(field.scoring),
                is_archived=False,
            )
        )
    db.flush()
    return template


def delete_form(db: Session, form: ReviewForm) -> None:
    """Delete a form outright, provided no reviewer responses depend on it.

    Extraction/quality responses pin a ``form_version_id`` without cascading
    delete, so removing a form that already has recorded responses would
    either orphan them or violate the FK -- guard against that up front with
    a clear error instead of letting the database reject the delete.
    """
    if _has_recorded_responses(db, form):
        raise ConflictError(
            "This form already has recorded reviewer responses and can't be "
            "deleted. Archive its fields instead if you need to change it."
        )
    db.delete(form)
    db.flush()


def copy_template_to_project(
    db: Session,
    template: ReviewForm,
    project_id: str,
    name: str | None = None,
) -> ReviewForm:
    if not template.is_template:
        raise ConflictError("Only templates can be copied")
    form = create_form(
        db,
        name or template.name,
        template.kind,
        project_id=project_id,
        is_template=False,
    )
    version = active_version(db, form)
    source = active_version(db, template)
    for field in list(
        db.scalars(
            select(FormField)
            .where(FormField.form_version_id == source.id)
            .order_by(FormField.position)
        )
    ):
        db.add(
            FormField(
                form_version_id=version.id,
                stable_key=field.stable_key,
                label=field.label,
                field_type=field.field_type,
                required=field.required,
                position=field.position,
                options=list(field.options),
                scoring=dict(field.scoring),
                is_archived=field.is_archived,
            )
        )
    db.flush()
    return form
