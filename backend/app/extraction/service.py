from __future__ import annotations

import hashlib
from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.accounts.models import User
from app.api.errors import DomainError, ForbiddenError, NotFoundError
from app.conflicts.models import FinalDecision
from app.extraction.models import (
    ExtractionResponse,
    ExtractionStatus,
    ExtractionWorkItem,
)
from app.forms.models import FieldType, FormField, FormKind, ReviewForm
from app.projects.models import Project, ProjectMembership, ScreeningStage
from app.screening.models import ScreeningOutcome


def utcnow() -> datetime:
    return datetime.now(UTC)


def project_form(db: Session, project_id: str) -> ReviewForm | None:
    return db.scalar(
        select(ReviewForm).where(
            ReviewForm.project_id == project_id, ReviewForm.kind == FormKind.EXTRACTION
        )
    )


def eligible_extractors(db: Session, project_id: str) -> list[str]:
    members = list(
        db.scalars(
            select(User.id)
            .join(ProjectMembership, ProjectMembership.user_id == User.id)
            .where(
                ProjectMembership.project_id == project_id,
                ProjectMembership.can_extract.is_(True),
                User.is_active.is_(True),
            )
            .order_by(User.username)
        )
    )
    admins = list(
        db.scalars(
            select(User.id)
            .where(User.is_admin.is_(True), User.is_active.is_(True))
            .order_by(User.username)
        )
    )
    return list(dict.fromkeys(members + admins))


def included_publication_ids(db: Session, project_id: str) -> list[str]:
    return list(
        db.scalars(
            select(FinalDecision.publication_id).where(
                FinalDecision.project_id == project_id,
                FinalDecision.stage == ScreeningStage.FULL_TEXT,
                FinalDecision.outcome == ScreeningOutcome.INCLUDE,
                FinalDecision.is_valid.is_(True),
            )
        )
    )


def initialize_extraction(db: Session, project: Project) -> int:
    if project_form(db, project.id) is None:
        return 0
    reviewers = eligible_extractors(db, project.id)
    if not reviewers:
        raise DomainError("At least one eligible extraction reviewer is required")
    created = 0
    for index, publication_id in enumerate(
        sorted(included_publication_ids(db, project.id))
    ):
        if db.scalar(
            select(ExtractionWorkItem.id).where(
                ExtractionWorkItem.publication_id == publication_id
            )
        ):
            continue
        rank = hashlib.sha256(
            f"{project.random_seed}:{project.id}:{publication_id}:extraction".encode()
        ).hexdigest()
        db.add(
            ExtractionWorkItem(
                project_id=project.id,
                publication_id=publication_id,
                assigned_reviewer_id=reviewers[index % len(reviewers)],
                random_rank=rank,
            )
        )
        created += 1
    db.flush()
    return created


def claim_next_extraction(
    db: Session, project_id: str, reviewer_id: str
) -> ExtractionWorkItem | None:
    now = utcnow()
    query = (
        select(ExtractionWorkItem)
        .where(
            ExtractionWorkItem.project_id == project_id,
            ExtractionWorkItem.assigned_reviewer_id == reviewer_id,
            ExtractionWorkItem.status != ExtractionStatus.COMPLETED,
            (
                (ExtractionWorkItem.status == ExtractionStatus.AVAILABLE)
                | (ExtractionWorkItem.reserved_until < now)
            ),
        )
        .order_by(ExtractionWorkItem.random_rank)
        .limit(1)
    )
    if db.bind is not None and db.bind.dialect.name == "postgresql":
        query = query.with_for_update(skip_locked=True)
    item = db.scalar(query)
    if item:
        item.status = ExtractionStatus.RESERVED
        item.reserved_until = now + timedelta(days=1)
        db.flush()
    return item


def save_draft(item: ExtractionWorkItem, reviewer_id: str, draft: dict) -> None:
    if item.assigned_reviewer_id != reviewer_id or item.status == ExtractionStatus.COMPLETED:
        raise ForbiddenError("This extraction work item cannot be edited")
    item.draft = draft


def active_fields(db: Session, form: ReviewForm) -> list[FormField]:
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


def validate_answers(fields: list[FormField], answers: dict) -> None:
    known = {field.stable_key: field for field in fields}
    unknown = set(answers) - set(known)
    if unknown:
        raise DomainError(f"Unknown form fields: {', '.join(sorted(unknown))}")
    for key, field in known.items():
        value = answers.get(key)
        if field.required and value in (None, "", []):
            raise DomainError(f"Required field is missing: {field.label}")
        if value is None:
            continue
        if field.field_type == FieldType.NUMBER and not isinstance(value, (int, float)):
            raise DomainError(f"Expected a number for: {field.label}")
        if field.field_type == FieldType.CHECKBOX and not isinstance(value, bool):
            raise DomainError(f"Expected a boolean for: {field.label}")
        if field.field_type == FieldType.MULTIPLE_SELECT and not isinstance(
            value, list
        ):
            raise DomainError(f"Expected a list for: {field.label}")
        if (
            field.field_type == FieldType.SINGLE_SELECT
            and field.options
            and value not in field.options
        ):
            raise DomainError(f"Invalid option for: {field.label}")
        if (
            field.field_type == FieldType.MULTIPLE_SELECT
            and field.options
            and any(item not in field.options for item in value)
        ):
            raise DomainError(f"Invalid option for: {field.label}")


def submit_extraction(
    db: Session, item: ExtractionWorkItem, reviewer_id: str, answers: dict
) -> ExtractionResponse:
    if item.assigned_reviewer_id != reviewer_id:
        raise ForbiddenError("Extraction is assigned to another reviewer")
    form = project_form(db, item.project_id)
    if form is None or not form.active_version_id:
        raise NotFoundError("Extraction form not found")
    validate_answers(active_fields(db, form), answers)
    current = db.scalar(
        select(ExtractionResponse).where(
            ExtractionResponse.work_item_id == item.id,
            ExtractionResponse.is_current.is_(True),
        )
    )
    version = 1
    if current:
        current.is_current = False
        version = current.version + 1
    response = ExtractionResponse(
        work_item_id=item.id,
        reviewer_id=reviewer_id,
        form_version_id=form.active_version_id,
        answers=answers,
        version=version,
    )
    db.add(response)
    item.status = ExtractionStatus.COMPLETED
    item.reserved_until = None
    item.completed_at = utcnow()
    item.draft = {}
    db.flush()
    return response


def reopen_for_required_field(db: Session, project_id: str) -> int:
    items = list(
        db.scalars(
            select(ExtractionWorkItem).where(
                ExtractionWorkItem.project_id == project_id,
                ExtractionWorkItem.status == ExtractionStatus.COMPLETED,
            )
        )
    )
    for item in items:
        item.status = ExtractionStatus.AVAILABLE
        item.completed_at = None
        item.reserved_until = None
    db.flush()
    return len(items)
