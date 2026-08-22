"""The single canonical source for "the authoritative evidence value for a
publication's field", across both extraction and quality data.

Every feature that needs "the current, traceable value of field X for
publication Y" -- the Evidence Matrix, and (later) Research Question
synthesis -- must build on `build_evidence_dataset` here rather than
hand-rolling its own resolution of final extraction/quality values.
`app.reporting.results.build_final_results` predates this module and has a
differently-shaped output (reviewer names, in-progress slot statuses); both
it and this module resolve the authoritative *value* through the same
`app.extraction.final.get_current_final_extraction(s)` helper, so there is
no duplicated resolution logic at the level that matters, even though the
two response shapes are not yet unified.

Only publications with a currently valid full-text INCLUDE decision are ever
in scope, matching every other "final results" consumer.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Literal

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.extraction.final import get_current_final_extractions
from app.extraction.models import ExtractionStatus, ExtractionWorkItem, FinalExtraction
from app.extraction.service import active_fields as extraction_active_fields
from app.extraction.service import project_form as extraction_project_form
from app.forms.models import FormField
from app.llm.models import (
    ExtractionSuggestionReview,
    LlmFieldSuggestion,
    SuggestionDisposition,
)
from app.llm.value_compare import values_equal
from app.publications.models import Publication
from app.quality.models import QualityConfig, QualityResponse, QualityWorkItem
from app.quality.service import active_fields as quality_active_fields
from app.quality.service import quality_form
from app.screening.cohorts import full_text_included_ids

FieldState = Literal["answered", "missing", "pending_reconciliation"]
SourceType = Literal["extraction", "quality"]


@dataclass(frozen=True)
class EvidenceRef:
    page: int
    quote: str
    section: str | None
    verified: bool


@dataclass(frozen=True)
class EvidenceFact:
    publication_id: str
    source_type: SourceType
    field_key: str
    label: str
    field_type: str
    value: Any
    state: FieldState
    resolution_method: str | None
    resolved_at: datetime | None
    resolved_by_id: str | None
    version_ref: str | None
    evidence: list[EvidenceRef] = field(default_factory=list)


@dataclass(frozen=True)
class EvidenceDataset:
    project_id: str
    publications: list[Publication]
    extraction_fields: list[FormField]
    quality_fields: list[FormField]
    quality_enabled: bool
    # {publication_id: {"extraction:<stable_key>" | "quality:<stable_key>": EvidenceFact}}
    facts_by_publication: dict[str, dict[str, EvidenceFact]]

    def facts_for(self, publication_id: str) -> dict[str, EvidenceFact]:
        return self.facts_by_publication.get(publication_id, {})


def _field_evidence(
    final: FinalExtraction,
    field_key: str,
    reviews_by_response_field: dict[tuple[str, str], ExtractionSuggestionReview],
    suggestions_by_id: dict[str, LlmFieldSuggestion],
) -> list[EvidenceRef]:
    """Traceability rules (see docs/llm-assisted-extraction.md):

    1. A value that came from a response whose accepted suggestion still
       exactly matches it is traceable through that suggestion's evidence.
    2. A value the reviewer modified after accepting a suggestion carries no
       inherited evidence (disposition is MODIFIED/REPLACED, not ACCEPTED).
    3. A reconciliation manual entry has no evidence unless it happens to
       exactly equal a contributing response's own accepted suggestion value.
    4. An agreement-finalized value is traceable through either contributing
       response, preferring slot A's for determinism.
    """
    provenance = final.field_provenance.get(field_key) or {}
    source = provenance.get("from")
    response_id = provenance.get("responseId")
    candidates: list[str]
    if source in ("agreed", "manual"):
        candidates = list(final.contributing_response_ids)
        if response_id and response_id in candidates:
            candidates.remove(response_id)
            candidates.insert(0, response_id)
    elif response_id:
        candidates = [response_id]
    else:
        candidates = []

    final_value = final.answers.get(field_key)
    for candidate_id in candidates:
        review = reviews_by_response_field.get((candidate_id, field_key))
        if (
            review is None
            or review.disposition != SuggestionDisposition.ACCEPTED
            or review.suggestion_id is None
            or not values_equal(review.reviewer_final_value, final_value)
        ):
            continue
        suggestion = suggestions_by_id.get(review.suggestion_id)
        if suggestion is None:
            continue
        return [
            EvidenceRef(
                page=int(item["page"]),
                quote=str(item["quote"]),
                section=item.get("section"),
                verified=bool(item.get("verified", False)),
            )
            for item in suggestion.evidence
        ]
    return []


def _answered(value: Any) -> bool:
    return value not in (None, "", [])


def build_evidence_dataset(
    db: Session, project_id: str, *, publication_ids: Sequence[str] | None = None
) -> EvidenceDataset:
    included = set(full_text_included_ids(db, project_id))
    scope = included if publication_ids is None else (set(publication_ids) & included)
    publications = list(
        db.scalars(
            select(Publication)
            .where(Publication.id.in_(scope))
            .order_by(Publication.title)
        )
    )
    pub_ids = [publication.id for publication in publications]

    extraction_form = extraction_project_form(db, project_id)
    extraction_fields = (
        extraction_active_fields(db, extraction_form) if extraction_form else []
    )

    quality_config = db.scalar(
        select(QualityConfig).where(QualityConfig.project_id == project_id)
    )
    quality_enabled = bool(quality_config and quality_config.enabled)
    quality_fields: list[FormField] = []
    if quality_enabled:
        q_form = quality_form(db, project_id)
        quality_fields = quality_active_fields(db, q_form) if q_form else []

    finals = get_current_final_extractions(db, pub_ids)

    slot_statuses: dict[str, list[ExtractionStatus]] = {}
    for pub_id, status in db.execute(
        select(ExtractionWorkItem.publication_id, ExtractionWorkItem.status).where(
            ExtractionWorkItem.project_id == project_id
        )
    ):
        slot_statuses.setdefault(pub_id, []).append(status)

    contributing_ids = {
        response_id
        for final in finals.values()
        for response_id in final.contributing_response_ids
    }
    reviews_by_response_field: dict[tuple[str, str], ExtractionSuggestionReview] = {}
    suggestions_by_id: dict[str, LlmFieldSuggestion] = {}
    if contributing_ids:
        for review in db.scalars(
            select(ExtractionSuggestionReview).where(
                ExtractionSuggestionReview.extraction_response_id.in_(contributing_ids)
            )
        ):
            if review.extraction_response_id:
                reviews_by_response_field[
                    (review.extraction_response_id, review.extraction_field_key)
                ] = review
        suggestion_ids = {
            review.suggestion_id
            for review in reviews_by_response_field.values()
            if review.suggestion_id
        }
        if suggestion_ids:
            for suggestion in db.scalars(
                select(LlmFieldSuggestion).where(
                    LlmFieldSuggestion.id.in_(suggestion_ids)
                )
            ):
                suggestions_by_id[suggestion.id] = suggestion

    quality_items: dict[str, QualityWorkItem] = {}
    quality_responses: dict[str, QualityResponse] = {}
    if quality_enabled and pub_ids:
        quality_items = {
            item.publication_id: item
            for item in db.scalars(
                select(QualityWorkItem).where(
                    QualityWorkItem.publication_id.in_(pub_ids)
                )
            )
        }
        if quality_items:
            quality_responses = {
                response.work_item_id: response
                for response in db.scalars(
                    select(QualityResponse).where(
                        QualityResponse.work_item_id.in_(
                            [item.id for item in quality_items.values()]
                        ),
                        QualityResponse.is_current.is_(True),
                    )
                )
            }

    facts_by_publication: dict[str, dict[str, EvidenceFact]] = {}
    for publication in publications:
        facts: dict[str, EvidenceFact] = {}
        final = finals.get(publication.id)
        if final is not None:
            for extraction_field in extraction_fields:
                key = extraction_field.stable_key
                value = final.answers.get(key)
                evidence = _field_evidence(
                    final, key, reviews_by_response_field, suggestions_by_id
                )
                facts[f"extraction:{key}"] = EvidenceFact(
                    publication_id=publication.id,
                    source_type="extraction",
                    field_key=key,
                    label=extraction_field.label,
                    field_type=extraction_field.field_type.value,
                    value=value,
                    state="answered" if _answered(value) else "missing",
                    resolution_method=final.resolution_method,
                    resolved_at=final.created_at,
                    resolved_by_id=final.resolved_by_id,
                    version_ref=final.id,
                    evidence=evidence,
                )
        else:
            slots = slot_statuses.get(publication.id, [])
            pending = bool(slots) and all(
                status == ExtractionStatus.COMPLETED for status in slots
            )
            state: FieldState = "pending_reconciliation" if pending else "missing"
            for extraction_field in extraction_fields:
                key = extraction_field.stable_key
                facts[f"extraction:{key}"] = EvidenceFact(
                    publication_id=publication.id,
                    source_type="extraction",
                    field_key=key,
                    label=extraction_field.label,
                    field_type=extraction_field.field_type.value,
                    value=None,
                    state=state,
                    resolution_method=None,
                    resolved_at=None,
                    resolved_by_id=None,
                    version_ref=None,
                )

        if quality_enabled:
            quality_item = quality_items.get(publication.id)
            quality_response = (
                quality_responses.get(quality_item.id) if quality_item else None
            )
            for quality_field in quality_fields:
                key = quality_field.stable_key
                value = quality_response.answers.get(key) if quality_response else None
                facts[f"quality:{key}"] = EvidenceFact(
                    publication_id=publication.id,
                    source_type="quality",
                    field_key=key,
                    label=quality_field.label,
                    field_type=quality_field.field_type.value,
                    value=value,
                    state=(
                        "answered"
                        if quality_response and _answered(value)
                        else "missing"
                    ),
                    resolution_method="single_reviewer" if quality_response else None,
                    resolved_at=(
                        quality_response.created_at if quality_response else None
                    ),
                    resolved_by_id=(
                        quality_response.reviewer_id if quality_response else None
                    ),
                    version_ref=quality_response.id if quality_response else None,
                )

        facts_by_publication[publication.id] = facts

    return EvidenceDataset(
        project_id=project_id,
        publications=publications,
        extraction_fields=extraction_fields,
        quality_fields=quality_fields,
        quality_enabled=quality_enabled,
        facts_by_publication=facts_by_publication,
    )
