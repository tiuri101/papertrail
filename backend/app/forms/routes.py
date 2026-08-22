from fastapi import APIRouter, Depends, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.accounts.dependencies import (
    get_current_user,
    require_admin_csrf,
    require_csrf,
)
from app.accounts.models import User, UserSession
from app.api.errors import ConflictError, DomainError, NotFoundError
from app.audit.service import record_audit
from app.db.session import get_db
from app.forms.models import FormField, FormKind, ReviewForm
from app.forms.schemas import (
    FieldCreate,
    FieldReplace,
    FieldResponse,
    FieldUpdate,
    FormCreate,
    FormResponse,
    FormUpdate,
    SaveAsTemplateRequest,
)
from app.forms.service import (
    active_version,
    add_field,
    archive_field,
    copy_template_to_project,
    create_form,
    delete_field,
    delete_form,
    find_field,
    project_form_by_kind,
    rename_field,
    replace_field,
    save_form_as_template,
    update_field,
)
from app.projects.dependencies import (
    require_any_project_manager,
    require_project_manager,
    require_project_manager_csrf,
)
from app.projects.service import (
    get_project,
    is_any_project_manager,
    require_manager_for,
)

router = APIRouter(tags=["forms"])


@router.get("/form-templates", response_model=list[FormResponse])
def list_templates(
    _: User = Depends(require_any_project_manager), db: Session = Depends(get_db)
) -> list[ReviewForm]:
    return list(
        db.scalars(
            select(ReviewForm)
            .where(ReviewForm.is_template.is_(True))
            .order_by(ReviewForm.name)
        )
    )


@router.post(
    "/form-templates", response_model=FormResponse, status_code=status.HTTP_201_CREATED
)
def add_template(
    payload: FormCreate,
    admin: User = Depends(require_admin_csrf),
    db: Session = Depends(get_db),
) -> ReviewForm:
    form = create_form(db, payload.name, FormKind(payload.kind), is_template=True)
    record_audit(
        db,
        action="form_template.created",
        entity_type="review_form",
        entity_id=form.id,
        actor_id=admin.id,
        summary=f"Created {form.kind.value} form template",
    )
    db.commit()
    return form


@router.post(
    "/projects/{project_id}/forms",
    response_model=FormResponse,
    status_code=status.HTTP_201_CREATED,
)
def add_project_form(
    project_id: str,
    payload: FormCreate,
    admin: User = Depends(require_project_manager_csrf),
    db: Session = Depends(get_db),
) -> ReviewForm:
    get_project(db, project_id)
    kind = FormKind(payload.kind)
    existing = project_form_by_kind(db, project_id, kind)
    if existing is not None:
        raise ConflictError(
            f"Project already has a {kind.value} form ('{existing.name}'). "
            "Edit that form instead of creating another one of the same kind."
        )
    if payload.template_id:
        template = db.get(ReviewForm, payload.template_id)
        if template is None:
            raise NotFoundError("Template not found")
        form = copy_template_to_project(db, template, project_id, payload.name)
    else:
        form = create_form(db, payload.name, kind, project_id=project_id)
    record_audit(
        db,
        action="project_form.created",
        entity_type="review_form",
        entity_id=form.id,
        project_id=project_id,
        actor_id=admin.id,
        summary=f"Created project {form.kind.value} form",
    )
    db.commit()
    return form


@router.delete("/forms/{form_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_form_endpoint(
    form_id: str,
    session: UserSession = Depends(require_csrf),
    db: Session = Depends(get_db),
) -> None:
    admin = session.user
    form = db.get(ReviewForm, form_id)
    if form is None:
        raise NotFoundError("Form not found")
    require_manager_for(db, admin, form.project_id)
    record_audit(
        db,
        action="form.deleted",
        entity_type="review_form",
        entity_id=form.id,
        project_id=form.project_id,
        actor_id=admin.id,
        summary=f"Deleted {form.kind.value} form '{form.name}'",
    )
    delete_form(db, form)
    db.commit()


@router.patch("/forms/{form_id}", response_model=FormResponse)
def update_form_endpoint(
    form_id: str,
    payload: FormUpdate,
    session: UserSession = Depends(require_csrf),
    db: Session = Depends(get_db),
) -> ReviewForm:
    admin = session.user
    form = db.get(ReviewForm, form_id)
    if form is None:
        raise NotFoundError("Form not found")
    require_manager_for(db, admin, form.project_id)
    previous_name = form.name
    form.name = payload.name.strip()
    record_audit(
        db,
        action="form_template.updated" if form.is_template else "form.updated",
        entity_type="review_form",
        entity_id=form.id,
        project_id=form.project_id,
        actor_id=admin.id,
        summary=f"Renamed form '{previous_name}' to '{form.name}'",
        metadata={"changes": {"name": {"from": previous_name, "to": form.name}}},
    )
    db.commit()
    return form


@router.post(
    "/forms/{form_id}/fields",
    response_model=FieldResponse,
    status_code=status.HTTP_201_CREATED,
)
def add_form_field(
    form_id: str,
    payload: FieldCreate,
    session: UserSession = Depends(require_csrf),
    db: Session = Depends(get_db),
) -> FormField:
    admin = session.user
    form = db.get(ReviewForm, form_id)
    if form is None:
        raise NotFoundError("Form not found")
    require_manager_for(db, admin, form.project_id)
    field = add_field(
        db,
        form,
        payload.label,
        payload.field_type,
        required=payload.required,
        options=payload.options,
        scoring=payload.scoring,
    )
    record_audit(
        db,
        action="form_field.added",
        entity_type="form_field",
        entity_id=field.id,
        project_id=form.project_id,
        actor_id=admin.id,
        summary=f"Added field to {form.name}",
    )
    db.commit()
    return field


@router.get("/projects/{project_id}/forms", response_model=list[FormResponse])
def list_project_forms(
    project_id: str,
    _: User = Depends(require_project_manager),
    db: Session = Depends(get_db),
) -> list[ReviewForm]:
    get_project(db, project_id)
    return list(
        db.scalars(
            select(ReviewForm)
            .where(ReviewForm.project_id == project_id)
            .order_by(ReviewForm.kind, ReviewForm.name)
        )
    )


@router.get("/forms/{form_id}/fields", response_model=list[FieldResponse])
def list_form_fields(
    form_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[FormField]:
    form = db.get(ReviewForm, form_id)
    if form is None or not form.active_version_id:
        raise NotFoundError("Form not found")
    if form.is_template:
        if not is_any_project_manager(db, user):
            raise NotFoundError("Form not found")
    else:
        require_manager_for(db, user, form.project_id)
    return list(
        db.scalars(
            select(FormField)
            .where(FormField.form_version_id == form.active_version_id)
            .order_by(FormField.position)
        )
    )


@router.patch("/forms/{form_id}/fields/{stable_key}", response_model=FieldResponse)
def update_form_field(
    form_id: str,
    stable_key: str,
    payload: FieldUpdate,
    session: UserSession = Depends(require_csrf),
    db: Session = Depends(get_db),
) -> FormField:
    admin = session.user
    form = db.get(ReviewForm, form_id)
    if form is None:
        raise NotFoundError("Form not found")
    require_manager_for(db, admin, form.project_id)
    current_field = find_field(db, active_version(db, form), stable_key)
    before = {
        "label": current_field.label,
        "fieldType": current_field.field_type.value,
        "required": current_field.required,
        "position": current_field.position,
        "options": current_field.options,
        "scoring": current_field.scoring,
        "isArchived": current_field.is_archived,
    }
    if payload.archive:
        field = archive_field(db, form, stable_key)
        action = "form_field.archived"
    elif any(
        value is not None
        for value in (
            payload.field_type,
            payload.required,
            payload.position,
            payload.options,
            payload.scoring,
        )
    ):
        field = update_field(
            db,
            form,
            stable_key,
            label=payload.label,
            field_type=payload.field_type,
            required=payload.required,
            position=payload.position,
            options=payload.options,
            scoring=payload.scoring,
        )
        action = "form_field.updated"
    elif payload.label is not None:
        field = rename_field(db, form, stable_key, payload.label)
        action = "form_field.renamed"
    else:
        raise DomainError("No form field update was supplied")
    after = {
        "label": field.label,
        "fieldType": field.field_type.value,
        "required": field.required,
        "position": field.position,
        "options": field.options,
        "scoring": field.scoring,
        "isArchived": field.is_archived,
    }
    changes = {
        key: {"from": before[key], "to": value}
        for key, value in after.items()
        if before[key] != value
    }
    record_audit(
        db,
        action=action,
        entity_type="form_field",
        entity_id=field.id,
        project_id=form.project_id,
        actor_id=admin.id,
        summary=f"Updated field '{field.label}' in {form.name}",
        metadata={"stableKey": stable_key, "changes": changes},
    )
    db.commit()
    return field


@router.delete(
    "/forms/{form_id}/fields/{stable_key}", status_code=status.HTTP_204_NO_CONTENT
)
def delete_form_field(
    form_id: str,
    stable_key: str,
    session: UserSession = Depends(require_csrf),
    db: Session = Depends(get_db),
) -> None:
    admin = session.user
    form = db.get(ReviewForm, form_id)
    if form is None:
        raise NotFoundError("Form not found")
    require_manager_for(db, admin, form.project_id)
    field_id = delete_field(db, form, stable_key)
    record_audit(
        db,
        action="form_field.deleted",
        entity_type="form_field",
        entity_id=field_id,
        project_id=form.project_id,
        actor_id=admin.id,
        summary=f"Removed field from {form.name}",
    )
    db.commit()


@router.post(
    "/forms/{form_id}/save-as-template",
    response_model=FormResponse,
    status_code=status.HTTP_201_CREATED,
)
def save_form_as_template_endpoint(
    form_id: str,
    payload: SaveAsTemplateRequest,
    session: UserSession = Depends(require_csrf),
    db: Session = Depends(get_db),
) -> ReviewForm:
    admin = session.user
    form = db.get(ReviewForm, form_id)
    if form is None:
        raise NotFoundError("Form not found")
    require_manager_for(db, admin, form.project_id)
    template = save_form_as_template(db, form, payload.name)
    record_audit(
        db,
        action="form_template.created_from_form",
        entity_type="review_form",
        entity_id=template.id,
        project_id=form.project_id,
        actor_id=admin.id,
        summary=f"Saved {form.name} as a reusable template",
    )
    db.commit()
    return template


@router.post(
    "/forms/{form_id}/fields/{stable_key}/replace", response_model=FieldResponse
)
def replace_form_field(
    form_id: str,
    stable_key: str,
    payload: FieldReplace,
    session: UserSession = Depends(require_csrf),
    db: Session = Depends(get_db),
) -> FormField:
    admin = session.user
    form = db.get(ReviewForm, form_id)
    if form is None:
        raise NotFoundError("Form not found")
    require_manager_for(db, admin, form.project_id)
    current_field = find_field(db, active_version(db, form), stable_key)
    before = {
        "label": current_field.label,
        "fieldType": current_field.field_type.value,
        "required": current_field.required,
        "position": current_field.position,
        "options": current_field.options,
        "scoring": current_field.scoring,
    }
    field = replace_field(
        db,
        form,
        stable_key,
        payload.field_type,
        label=payload.label,
        required=payload.required,
        position=payload.position,
        options=payload.options,
        scoring=payload.scoring,
    )
    record_audit(
        db,
        action="form_field.replaced",
        entity_type="form_field",
        entity_id=field.id,
        project_id=form.project_id,
        actor_id=admin.id,
        summary=f"Replaced field in {form.name}",
        metadata={
            "replacedStableKey": stable_key,
            "replacementStableKey": field.stable_key,
            "changes": {
                key: {"from": before[key], "to": value}
                for key, value in {
                    "label": field.label,
                    "fieldType": field.field_type.value,
                    "required": field.required,
                    "position": field.position,
                    "options": field.options,
                    "scoring": field.scoring,
                }.items()
                if before[key] != value
            },
        },
    )
    db.commit()
    return field
