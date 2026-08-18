"""Deterministic, non-LLM Evidence Matrix: included publications x
extraction/quality fields, built entirely on top of
app.reporting.evidence_dataset -- never a second implementation of "the
final value for this field." Server-side search, per-field filtering, and
pagination live here as small, independently testable pure functions over
EvidenceFact values.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy.orm import Session

from app.api.errors import NotFoundError
from app.publications.models import Publication
from app.reporting.evidence_dataset import EvidenceFact, build_evidence_dataset

FilterPredicate = dict[str, Any]


def _fact_key(source_type: str, field_key: str) -> str:
    return f"{source_type}:{field_key}"


def matches_filter(fact: EvidenceFact | None, predicate: FilterPredicate) -> bool:
    """A single field's filter predicate against a (possibly absent) fact.

    Predicate shapes:
      {"type": "presence", "state": "answered" | "missing" | "pending_reconciliation"}
      {"type": "text", "contains": str}
      {"type": "categorical", "values": [str, ...]}
      {"type": "multi_select", "anyOf": [str, ...]}
      {"type": "numeric", "min": float | None, "max": float | None}
    """
    kind = predicate.get("type")
    if kind == "presence":
        state = fact.state if fact is not None else "missing"
        return state == predicate.get("state")
    if fact is None or fact.state != "answered":
        return False
    value = fact.value
    if kind == "text":
        needle = str(predicate.get("contains", "")).strip().lower()
        return not needle or needle in str(value).lower()
    if kind == "categorical":
        allowed = predicate.get("values") or []
        return not allowed or str(value) in {str(item) for item in allowed}
    if kind == "multi_select":
        allowed = {str(item) for item in (predicate.get("anyOf") or [])}
        if not allowed:
            return True
        values = value if isinstance(value, list) else []
        return bool(allowed.intersection(str(item) for item in values))
    if kind == "numeric":
        try:
            numeric_value = float(value)
        except (TypeError, ValueError):
            return False
        minimum = predicate.get("min")
        maximum = predicate.get("max")
        if minimum is not None and numeric_value < float(minimum):
            return False
        return not (maximum is not None and numeric_value > float(maximum))
    raise ValueError(f"Unknown evidence-matrix filter type: {kind!r}")


def matches_search(
    publication: Publication, facts: dict[str, EvidenceFact], search: str
) -> bool:
    needle = search.strip().lower()
    if not needle:
        return True
    if needle in (publication.title or "").lower():
        return True
    if publication.authors and needle in str(publication.authors).lower():
        return True
    return any(
        fact.state == "answered" and needle in str(fact.value).lower()
        for fact in facts.values()
    )


def build_evidence_matrix(
    db: Session,
    project_id: str,
    *,
    search: str | None = None,
    filters: dict[str, FilterPredicate] | None = None,
    page: int = 1,
    page_size: int = 25,
) -> dict[str, Any]:
    dataset = build_evidence_dataset(db, project_id)
    filters = filters or {}

    matching: list[tuple[Publication, dict[str, EvidenceFact]]] = []
    for publication in dataset.publications:
        facts = dataset.facts_for(publication.id)
        if search and not matches_search(publication, facts, search):
            continue
        if all(
            matches_filter(facts.get(field_key), predicate)
            for field_key, predicate in filters.items()
        ):
            matching.append((publication, facts))

    total = len(matching)
    start = max(page - 1, 0) * page_size
    page_rows = matching[start : start + page_size]

    columns = [
        {
            "key": _fact_key("extraction", extraction_field.stable_key),
            "label": extraction_field.label,
            "fieldType": extraction_field.field_type.value,
            "source": "extraction",
            "options": extraction_field.options or None,
        }
        for extraction_field in dataset.extraction_fields
    ] + [
        {
            "key": _fact_key("quality", quality_field.stable_key),
            "label": quality_field.label,
            "fieldType": quality_field.field_type.value,
            "source": "quality",
            "options": quality_field.options or None,
        }
        for quality_field in dataset.quality_fields
    ]

    column_keys = [str(column["key"]) for column in columns]
    items = [
        {
            "publication": {
                "id": publication.id,
                "title": publication.title,
                "authors": publication.authors,
                "publicationYear": publication.publication_year,
            },
            "cells": {
                key: (
                    {
                        "value": facts[key].value,
                        "state": facts[key].state,
                        "hasEvidence": bool(facts[key].evidence),
                    }
                    if key in facts
                    else {"value": None, "state": "missing", "hasEvidence": False}
                )
                for key in column_keys
            },
        }
        for publication, facts in page_rows
    ]

    return {
        "columns": columns,
        "items": items,
        "total": total,
        "page": page,
        "pageSize": page_size,
        "qualityEnabled": dataset.quality_enabled,
    }


def evidence_cell_detail(
    db: Session, project_id: str, publication_id: str, source_type: str, field_key: str
) -> dict[str, Any]:
    dataset = build_evidence_dataset(db, project_id, publication_ids=[publication_id])
    publication = next(
        (item for item in dataset.publications if item.id == publication_id), None
    )
    if publication is None:
        raise NotFoundError("Publication not found in the evidence dataset")
    fact = dataset.facts_for(publication_id).get(_fact_key(source_type, field_key))
    if fact is None:
        raise NotFoundError("Field not found for this publication")

    return {
        "publication": {"id": publication.id, "title": publication.title},
        "fieldKey": fact.field_key,
        "label": fact.label,
        "fieldType": fact.field_type,
        "sourceType": fact.source_type,
        "value": fact.value,
        "state": fact.state,
        "resolutionMethod": fact.resolution_method,
        "resolvedAt": fact.resolved_at,
        "evidence": [
            {
                "page": item.page,
                "quote": item.quote,
                "section": item.section,
                "verified": item.verified,
            }
            for item in fact.evidence
        ],
    }
