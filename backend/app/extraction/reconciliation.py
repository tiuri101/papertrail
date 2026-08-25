"""Reconciliation between two independent extraction reviewer slots.

Orchestrates: detecting whether both required extraction slots for a
publication agree closely enough to auto-finalize (app.extraction.comparison
does the actual field-by-field comparison), maintaining the derived
reconciliation queue for publications that disagree, and recording a
manager/adjudicator's manual field-by-field resolution as the authoritative
FinalExtraction.

In single-reviewer mode (required_reviewers == 1) attempt_auto_finalize is
still the code path that makes a submitted response immediately
authoritative -- there is just never more than one slot to wait for, so no
reconciliation queue entry is ever possible.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.errors import DomainError, NotFoundError
from app.audit.service import record_audit
from app.extraction.comparison import ComparisonResult, compare_answers
from app.extraction.final import (
    create_or_replace_final_extraction,
    get_current_final_extraction,
    invalidate_current_final_extraction,
)
from app.extraction.models import (
    ExtractionResponse,
    ExtractionStatus,
    ExtractionWorkItem,
    FinalExtraction,
)
from app.forms.models import FormField
from app.publications.models import Publication

_REVISION_INVALIDATION_REASON = "reviewer_revision"


def required_reviewers_for(db: Session, project_id: str) -> int:
    from app.extraction.service import extraction_required_reviewers

    return extraction_required_reviewers(db, project_id)


def _completed_slot_pairs(
    db: Session, publication_id: str
) -> list[tuple[ExtractionWorkItem, ExtractionResponse]]:
    items = list(
        db.scalars(
            select(ExtractionWorkItem)
            .where(
                ExtractionWorkItem.publication_id == publication_id,
                ExtractionWorkItem.status == ExtractionStatus.COMPLETED,
            )
            .order_by(ExtractionWorkItem.slot_number)
        )
    )
    pairs: list[tuple[ExtractionWorkItem, ExtractionResponse]] = []
    for item in items:
        response = db.scalar(
            select(ExtractionResponse).where(
                ExtractionResponse.work_item_id == item.id,
                ExtractionResponse.is_current.is_(True),
            )
        )
        if response is not None:
            pairs.append((item, response))
    return pairs


def _fields_for_form_versions(
    db: Session, form_version_ids: set[str]
) -> list[FormField]:
    """The union of active fields across one or more form versions, keyed by
    stable_key -- used to compare two responses that may have been completed
    against different form versions if the form changed mid-project."""
    seen: dict[str, FormField] = {}
    for form_field in db.scalars(
        select(FormField)
        .where(
            FormField.form_version_id.in_(form_version_ids),
            FormField.is_archived.is_(False),
        )
        .order_by(FormField.position)
    ):
        seen.setdefault(form_field.stable_key, form_field)
    return list(seen.values())


def _audit_final_invalidated(
    db: Session, publication: Publication, previous: FinalExtraction
) -> None:
    record_audit(
        db,
        action="extraction.final_invalidated",
        entity_type="final_extraction",
        entity_id=previous.id,
        project_id=publication.project_id,
        summary=(
            f'Authoritative extraction for "{publication.title}" invalidated '
            "by reviewer revision"
        ),
        metadata={
            "publicationId": publication.id,
            "reason": _REVISION_INVALIDATION_REASON,
        },
    )


def attempt_auto_finalize(db: Session, publication_id: str) -> FinalExtraction | None:
    """Called after a slot is submitted (initial completion or revision).

    Returns the new FinalExtraction if one was created (single-reviewer mode
    always; dual-reviewer mode only on agreement), or None if the
    publication is now waiting on the other slot, or sitting in the
    reconciliation queue.
    """
    publication = db.get(Publication, publication_id)
    if publication is None:
        raise NotFoundError("Publication not found")
    pairs = _completed_slot_pairs(db, publication_id)
    if not pairs:
        return None
    required = required_reviewers_for(db, publication.project_id)
    if len(pairs) < required:
        return None

    previous_final = get_current_final_extraction(db, publication_id)

    if required <= 1:
        _item, response = pairs[0]
        final = create_or_replace_final_extraction(
            db,
            project_id=publication.project_id,
            publication_id=publication_id,
            form_version_id=response.form_version_id,
            answers=dict(response.answers),
            resolution_method="single_reviewer",
            resolved_by_id=None,
            note=None,
            field_provenance={
                key: {"from": "response_a", "responseId": response.id}
                for key in response.answers
            },
            contributing_response_ids=[response.id],
            invalidation_reason=_REVISION_INVALIDATION_REASON,
        )
        if previous_final is not None:
            _audit_final_invalidated(db, publication, previous_final)
        return final

    (_item_a, response_a), (_item_b, response_b) = pairs[0], pairs[1]
    fields = _fields_for_form_versions(
        db, {response_a.form_version_id, response_b.form_version_id}
    )
    comparison = compare_answers(fields, response_a.answers, response_b.answers)

    if comparison.all_agree:
        merged: dict[str, Any] = {}
        provenance: dict[str, Any] = {}
        for item in comparison.fields:
            value = response_a.answers.get(
                item.stable_key, response_b.answers.get(item.stable_key)
            )
            merged[item.stable_key] = value
            provenance[item.stable_key] = {
                "from": "agreed",
                "responseId": response_a.id,
            }
        final = create_or_replace_final_extraction(
            db,
            project_id=publication.project_id,
            publication_id=publication_id,
            form_version_id=response_a.form_version_id,
            answers=merged,
            resolution_method="agreement",
            resolved_by_id=None,
            note=None,
            field_provenance=provenance,
            contributing_response_ids=[response_a.id, response_b.id],
            invalidation_reason=_REVISION_INVALIDATION_REASON,
        )
        if previous_final is not None:
            _audit_final_invalidated(db, publication, previous_final)
        record_audit(
            db,
            action="extraction.auto_finalized",
            entity_type="final_extraction",
            entity_id=final.id,
            project_id=publication.project_id,
            summary=(
                f'Extraction for "{publication.title}" automatically finalized: '
                "reviewers agreed"
            ),
            metadata={"publicationId": publication_id},
        )
        return final

    if previous_final is not None:
        invalidate_current_final_extraction(
            db, publication_id, _REVISION_INVALIDATION_REASON
        )
        _audit_final_invalidated(db, publication, previous_final)
    record_audit(
        db,
        action="extraction.reconciliation_required",
        entity_type="publication",
        entity_id=publication_id,
        project_id=publication.project_id,
        summary=f'Extraction for "{publication.title}" requires reconciliation: reviewers disagree',
        metadata={
            "publicationId": publication_id,
            "disagreeingFields": comparison.disagreeing_keys,
        },
    )
    return None


def reconciliation_queue(db: Session, project_id: str) -> list[Publication]:
    """Publications with all required extraction slots completed but no
    current authoritative FinalExtraction (i.e. genuinely disagreeing, not
    just still waiting on the other slot)."""
    required = required_reviewers_for(db, project_id)
    if required <= 1:
        return []
    candidate_ids = list(
        db.scalars(
            select(ExtractionWorkItem.publication_id)
            .where(
                ExtractionWorkItem.project_id == project_id,
                ExtractionWorkItem.status == ExtractionStatus.COMPLETED,
            )
            .group_by(ExtractionWorkItem.publication_id)
            .having(func.count() >= required)
        )
    )
    publications: list[Publication] = []
    for publication_id in candidate_ids:
        if get_current_final_extraction(db, publication_id) is not None:
            continue
        publication = db.get(Publication, publication_id)
        if publication is not None:
            publications.append(publication)
    return publications


def reconciliation_detail(
    db: Session, publication_id: str
) -> tuple[Publication, list[FormField], ComparisonResult]:
    """The publication, active fields, and field-by-field comparison of the
    two current slot responses, for rendering the reconciliation workspace."""
    from app.extraction.service import active_fields, project_form

    publication = db.get(Publication, publication_id)
    if publication is None:
        raise NotFoundError("Publication not found")
    pairs = _completed_slot_pairs(db, publication_id)
    required = required_reviewers_for(db, publication.project_id)
    if required <= 1 or len(pairs) < required:
        raise DomainError(
            "Both extraction slots must be completed before reconciliation"
        )
    form = project_form(db, publication.project_id)
    if form is None or not form.active_version_id:
        raise NotFoundError("Extraction form not found")
    fields = active_fields(db, form)
    (_item_a, response_a), (_item_b, response_b) = pairs[0], pairs[1]
    comparison = compare_answers(fields, response_a.answers, response_b.answers)
    return publication, fields, comparison


def submit_reconciliation(
    db: Session,
    publication_id: str,
    resolver_id: str,
    field_choices: dict[str, dict[str, Any]],
    note: str | None,
) -> FinalExtraction:
    from app.extraction.service import (
        active_fields,
        normalize_answers,
        project_form,
        validate_answers,
    )

    if not note or not note.strip():
        raise DomainError("A reconciliation note is required")

    publication = db.get(Publication, publication_id)
    if publication is None:
        raise NotFoundError("Publication not found")
    pairs = _completed_slot_pairs(db, publication_id)
    required = required_reviewers_for(db, publication.project_id)
    if required <= 1 or len(pairs) < required:
        raise DomainError(
            "Both extraction slots must be completed before reconciliation"
        )
    form = project_form(db, publication.project_id)
    if form is None or not form.active_version_id:
        raise NotFoundError("Extraction form not found")
    fields = active_fields(db, form)
    (_item_a, response_a), (_item_b, response_b) = pairs[0], pairs[1]
    comparison = compare_answers(fields, response_a.answers, response_b.answers)

    merged: dict[str, Any] = {}
    provenance: dict[str, Any] = {}
    resolved_choices: dict[str, str] = {}
    for item in comparison.fields:
        if item.agree:
            # Agreeing fields are prepopulated and are not independently
            # overridable to a third value here -- overriding an agreeing
            # field is out of scope for reconciliation; use the separate
            # manager-override path instead.
            value = response_a.answers.get(
                item.stable_key, response_b.answers.get(item.stable_key)
            )
            merged[item.stable_key] = value
            provenance[item.stable_key] = {
                "from": "agreed",
                "responseId": response_a.id,
            }
            continue
        choice = field_choices.get(item.stable_key)
        if choice is None or "choice" not in choice:
            raise DomainError(
                f"A resolution is required for disagreeing field: {item.stable_key}"
            )
        selection = choice["choice"]
        if selection == "response_a":
            merged[item.stable_key] = response_a.answers.get(item.stable_key)
            provenance[item.stable_key] = {
                "from": "response_a",
                "responseId": response_a.id,
            }
        elif selection == "response_b":
            merged[item.stable_key] = response_b.answers.get(item.stable_key)
            provenance[item.stable_key] = {
                "from": "response_b",
                "responseId": response_b.id,
            }
        elif selection == "manual":
            merged[item.stable_key] = choice.get("value")
            provenance[item.stable_key] = {"from": "manual", "responseId": None}
        else:
            raise DomainError(f"Invalid resolution choice for field: {item.stable_key}")
        resolved_choices[item.stable_key] = selection

    merged = normalize_answers(fields, merged)
    validate_answers(fields, merged)

    final = create_or_replace_final_extraction(
        db,
        project_id=publication.project_id,
        publication_id=publication_id,
        form_version_id=form.active_version_id,
        answers=merged,
        resolution_method="reconciliation",
        resolved_by_id=resolver_id,
        note=note,
        field_provenance=provenance,
        contributing_response_ids=[response_a.id, response_b.id],
    )
    record_audit(
        db,
        action="extraction.reconciliation_completed",
        entity_type="final_extraction",
        entity_id=final.id,
        project_id=publication.project_id,
        actor_id=resolver_id,
        summary=f'Reconciled data extraction for "{publication.title}"',
        metadata={"publicationId": publication_id, "resolvedFields": resolved_choices},
    )
    return final
