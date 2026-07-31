from fastapi import APIRouter, Depends, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.accounts.dependencies import require_admin, require_admin_csrf
from app.accounts.models import User
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
    SaveAsTemplateRequest,
)
from app.forms.service import (
    add_field,
    archive_field,
    copy_template_to_project,
    create_form,
    delete_form,
    rename_field,
    replace_field,
    save_form_as_template,
)
from app.projects.service import get_project

router = APIRouter(tags=["forms"])


@router.get("/form-templates", response_model=list[FormResponse])
def list_templates(_: User = Depends(require_admin), db: Session = Depends(get_db)):
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
):
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
    admin: User = Depends(require_admin_csrf),
    db: Session = Depends(get_db),
):
    get_project(db, project_id)
    kind = FormKind(payload.kind)
    existing = db.scalar(
        select(ReviewForm).where(
            ReviewForm.project_id == project_id, ReviewForm.kind == kind
        )
    )
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
    admin: User = Depends(require_admin_csrf),
    db: Session = Depends(get_db),
):
    form = db.get(ReviewForm, form_id)
    if form is None:
        raise NotFoundError("Form not found")
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


@router.post(
    "/forms/{form_id}/fields",
    response_model=FieldResponse,
    status_code=status.HTTP_201_CREATED,
)
def add_form_field(
    form_id: str,
    payload: FieldCreate,
    admin: User = Depends(require_admin_csrf),
    db: Session = Depends(get_db),
):
    form = db.get(ReviewForm, form_id)
    if form is None:
        raise NotFoundError("Form not found")
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
    _: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
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
    _: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    form = db.get(ReviewForm, form_id)
    if form is None or not form.active_version_id:
        raise NotFoundError("Form not found")
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
    admin: User = Depends(require_admin_csrf),
    db: Session = Depends(get_db),
):
    form = db.get(ReviewForm, form_id)
    if form is None:
        raise NotFoundError("Form not found")
    if payload.archive:
        field = archive_field(db, form, stable_key)
        action = "form_field.archived"
    elif payload.label is not None:
        field = rename_field(db, form, stable_key, payload.label)
        action = "form_field.renamed"
    else:
        raise DomainError("No form field update was supplied")
    record_audit(
        db,
        action=action,
        entity_type="form_field",
        entity_id=field.id,
        project_id=form.project_id,
        actor_id=admin.id,
        summary=f"Updated field in {form.name}",
    )
    db.commit()
    return field


@router.post(
    "/forms/{form_id}/save-as-template",
    response_model=FormResponse,
    status_code=status.HTTP_201_CREATED,
)
def save_form_as_template_endpoint(
    form_id: str,
    payload: SaveAsTemplateRequest,
    admin: User = Depends(require_admin_csrf),
    db: Session = Depends(get_db),
):
    form = db.get(ReviewForm, form_id)
    if form is None:
        raise NotFoundError("Form not found")
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
    admin: User = Depends(require_admin_csrf),
    db: Session = Depends(get_db),
):
    form = db.get(ReviewForm, form_id)
    if form is None:
        raise NotFoundError("Form not found")
    field = replace_field(
        db,
        form,
        stable_key,
        payload.field_type,
        label=payload.label,
        required=payload.required,
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
        metadata={"replacedStableKey": stable_key},
    )
    db.commit()
    return field
