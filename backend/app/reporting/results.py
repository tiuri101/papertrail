from __future__ import annotations

from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.accounts.models import User
from app.extraction.final import get_current_final_extractions
from app.extraction.models import ExtractionResponse, ExtractionStatus, ExtractionWorkItem
from app.extraction.service import active_fields as extraction_active_fields
from app.extraction.service import project_form
from app.forms.models import FormField
from app.projects.lifecycle import included_publication_ids
from app.publications.models import Publication
from app.quality.models import QualityConfig, QualityResponse, QualityWorkItem
from app.quality.service import active_fields as quality_active_fields
from app.quality.service import quality_form


def _user_names(db: Session) -> dict[str, str]:
    return {
        row.id: row.display_name
        for row in db.execute(select(User.id, User.display_name))
    }


def _field_meta(fields: list[FormField]) -> list[dict[str, Any]]:
    return [
        {
            "stableKey": field.stable_key,
            "label": field.label,
            "fieldType": field.field_type.value,
        }
        for field in fields
    ]


def build_final_results(db: Session, project_id: str) -> dict[str, Any]:
    publication_ids = included_publication_ids(db, project_id)
    publications = list(
        db.scalars(
            select(Publication)
            .where(Publication.id.in_(publication_ids))
            .order_by(Publication.title)
        )
    )
    user_names = _user_names(db)

    extraction_form = project_form(db, project_id)
    extraction_fields = (
        extraction_active_fields(db, extraction_form) if extraction_form else []
    )
    # Per-publication slot statuses, used only to represent progress while no
    # authoritative final exists yet -- the authoritative *value* always
    # comes from FinalExtraction, never an individual slot's response.
    extraction_slots_by_publication: dict[str, list[ExtractionStatus]] = {}
    for pub_id, status in db.execute(
        select(ExtractionWorkItem.publication_id, ExtractionWorkItem.status).where(
            ExtractionWorkItem.project_id == project_id
        )
    ):
        extraction_slots_by_publication.setdefault(pub_id, []).append(status)
    final_extractions = get_current_final_extractions(db, list(publication_ids))
    contributing_response_ids = {
        response_id
        for final in final_extractions.values()
        for response_id in final.contributing_response_ids
    }
    responses_by_id = (
        {
            response.id: response
            for response in db.scalars(
                select(ExtractionResponse).where(
                    ExtractionResponse.id.in_(contributing_response_ids)
                )
            )
        }
        if contributing_response_ids
        else {}
    )

    config = db.scalar(
        select(QualityConfig).where(QualityConfig.project_id == project_id)
    )
    quality_enabled = bool(config and config.enabled)
    quality_fields: list[FormField] = []
    quality_items: dict[str, QualityWorkItem] = {}
    quality_responses: dict[str, QualityResponse] = {}
    if quality_enabled:
        form = quality_form(db, project_id)
        quality_fields = quality_active_fields(db, form) if form else []
        quality_items = {
            item.publication_id: item
            for item in db.scalars(
                select(QualityWorkItem).where(QualityWorkItem.project_id == project_id)
            )
        }
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

    items = []
    for publication in publications:
        final = final_extractions.get(publication.id)
        extraction_payload = None
        if final is not None:
            reviewer_name = None
            if final.resolved_by_id:
                reviewer_name = user_names.get(final.resolved_by_id)
            elif final.resolution_method == "single_reviewer" and final.contributing_response_ids:
                response = responses_by_id.get(final.contributing_response_ids[0])
                reviewer_name = user_names.get(response.reviewer_id) if response else None
            extraction_payload = {
                "status": "completed",
                "resolutionMethod": final.resolution_method,
                "completedAt": final.created_at,
                "reviewerName": reviewer_name,
                "answers": final.answers,
            }
        else:
            slots = extraction_slots_by_publication.get(publication.id)
            if slots:
                # No authoritative result yet. Never surface an individual,
                # unresolved response as though it were final -- report a
                # progress status instead: the raw per-slot status in
                # single-reviewer mode (unchanged from before), or, once
                # every slot is done but they disagree, an explicit
                # "reconciliation_pending" state distinct from "completed".
                if all(status == ExtractionStatus.COMPLETED for status in slots):
                    status_value = "reconciliation_pending"
                elif any(status == ExtractionStatus.RESERVED for status in slots):
                    status_value = ExtractionStatus.RESERVED.value
                else:
                    status_value = ExtractionStatus.AVAILABLE.value
                extraction_payload = {
                    "status": status_value,
                    "resolutionMethod": None,
                    "completedAt": None,
                    "reviewerName": None,
                    "answers": {},
                }

        quality_payload = None
        if quality_enabled:
            quality_item = quality_items.get(publication.id)
            if quality_item is not None:
                quality_response = quality_responses.get(quality_item.id)
                quality_payload = {
                    "status": quality_item.status,
                    "completedAt": quality_item.completed_at,
                    "reviewerName": (
                        user_names.get(quality_item.assigned_reviewer_id)
                        if quality_item.assigned_reviewer_id
                        else None
                    ),
                    "totalScore": (
                        quality_response.total_score if quality_response else None
                    ),
                    "answers": quality_response.answers if quality_response else {},
                }

        items.append(
            {
                "publication": {
                    "id": publication.id,
                    "title": publication.title,
                    "authors": publication.authors,
                    "publicationYear": publication.publication_year,
                    "venue": publication.venue,
                    "publicationType": publication.publication_type,
                    "doi": publication.doi,
                    "publisherUrl": publication.publisher_url,
                    "keywords": publication.keywords,
                },
                "extraction": extraction_payload,
                "quality": quality_payload,
            }
        )

    return {
        "qualityEnabled": quality_enabled,
        "extractionFields": _field_meta(extraction_fields),
        "qualityFields": _field_meta(quality_fields),
        "items": items,
    }
