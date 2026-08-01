from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.accounts.models import User
from app.extraction.models import ExtractionResponse, ExtractionWorkItem
from app.extraction.service import active_fields as extraction_active_fields
from app.extraction.service import project_form
from app.forms.models import FormField
from app.projects.lifecycle import included_publication_ids
from app.publications.models import Publication
from app.quality.models import QualityConfig, QualityResponse, QualityWorkItem
from app.quality.service import active_fields as quality_active_fields
from app.quality.service import quality_form


def _user_names(db: Session) -> dict[str, str]:
    return dict(db.execute(select(User.id, User.display_name)).all())


def _field_meta(fields: list[FormField]) -> list[dict]:
    return [
        {
            "stableKey": field.stable_key,
            "label": field.label,
            "fieldType": field.field_type.value,
        }
        for field in fields
    ]


def build_final_results(db: Session, project_id: str) -> dict:
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
    extraction_items = {
        item.publication_id: item
        for item in db.scalars(
            select(ExtractionWorkItem).where(
                ExtractionWorkItem.project_id == project_id
            )
        )
    }
    extraction_responses = {
        response.work_item_id: response
        for response in db.scalars(
            select(ExtractionResponse).where(
                ExtractionResponse.work_item_id.in_(
                    [item.id for item in extraction_items.values()]
                ),
                ExtractionResponse.is_current.is_(True),
            )
        )
    }

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
        extraction_item = extraction_items.get(publication.id)
        extraction_payload = None
        if extraction_item is not None:
            response = extraction_responses.get(extraction_item.id)
            extraction_payload = {
                "status": extraction_item.status,
                "completedAt": extraction_item.completed_at,
                "reviewerName": user_names.get(extraction_item.assigned_reviewer_id),
                "answers": response.answers if response else {},
            }

        quality_payload = None
        if quality_enabled:
            quality_item = quality_items.get(publication.id)
            if quality_item is not None:
                response = quality_responses.get(quality_item.id)
                quality_payload = {
                    "status": quality_item.status,
                    "completedAt": quality_item.completed_at,
                    "reviewerName": user_names.get(quality_item.assigned_reviewer_id),
                    "totalScore": response.total_score if response else None,
                    "answers": response.answers if response else {},
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
