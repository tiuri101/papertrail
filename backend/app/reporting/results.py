from __future__ import annotations

from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.accounts.models import User
from app.extraction.final import get_current_final_extractions
from app.extraction.models import ExtractionResponse
from app.extraction.service import active_fields as extraction_active_fields
from app.extraction.service import project_form
from app.extraction.status import (
    PublicationExtractionStatus,
    publication_extraction_statuses,
)
from app.forms.models import FormField
from app.publications.models import Publication
from app.quality.models import QualityConfig, QualityResponse, QualityWorkItem
from app.quality.service import active_fields as quality_active_fields
from app.quality.service import quality_form
from app.screening.cohorts import full_text_included_ids


def user_names(db: Session) -> dict[str, str]:
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
    publication_ids = full_text_included_ids(db, project_id)
    publications = list(
        db.scalars(
            select(Publication)
            .where(Publication.id.in_(publication_ids))
            .order_by(Publication.title)
        )
    )
    reviewer_names = user_names(db)

    extraction_form = project_form(db, project_id)
    extraction_fields = (
        extraction_active_fields(db, extraction_form) if extraction_form else []
    )
    # Progress while no authoritative final exists yet -- the authoritative
    # *value* always comes from FinalExtraction, never an individual slot's
    # response. Derived by app.extraction.status so this export and the
    # publication list report the same vocabulary for the same state.
    extraction_statuses = publication_extraction_statuses(db, list(publication_ids))
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
                reviewer_name = reviewer_names.get(final.resolved_by_id)
            elif (
                final.resolution_method == "single_reviewer"
                and final.contributing_response_ids
            ):
                response = responses_by_id.get(final.contributing_response_ids[0])
                reviewer_name = (
                    reviewer_names.get(response.reviewer_id) if response else None
                )
            extraction_payload = {
                "status": "completed",
                "resolutionMethod": final.resolution_method,
                "completedAt": final.created_at,
                "reviewerName": reviewer_name,
                "answers": final.answers,
            }
        else:
            # No authoritative result yet. Never surface an individual,
            # unresolved response as though it were final -- report the
            # publication's derived progress state instead.
            derived = extraction_statuses.get(
                publication.id, PublicationExtractionStatus.NOT_STARTED
            )
            if derived != PublicationExtractionStatus.NOT_STARTED:
                extraction_payload = {
                    "status": derived.value,
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
                        reviewer_names.get(quality_item.assigned_reviewer_id)
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
