from __future__ import annotations

import re
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.imports.models import ImportBatch, ImportedRecord
from app.publications.models import MetadataConflict, Publication, PublicationSource

IMPORTANT_FIELDS = {"doi", "title", "authors", "publication_year", "abstract", "venue"}


def clean_text(value: Any) -> str | None:
    if value is None:
        return None
    text = re.sub(r"\s+", " ", str(value)).strip()
    return text or None


def normalize_doi(value: Any) -> str | None:
    text = clean_text(value)
    if not text:
        return None
    text = re.sub(r"^(?:https?://(?:dx\.)?doi\.org/|doi:\s*)", "", text, flags=re.I)
    return text.strip().lower() or None


def parse_year(value: Any) -> int | None:
    if value is None or value == "":
        return None
    match = re.search(r"(?:19|20)\d{2}", str(value))
    return int(match.group()) if match else None


def publication_values(parsed: dict[str, Any]) -> dict[str, Any]:
    return {
        "title": clean_text(parsed.get("title")) or "Untitled record",
        "authors": clean_text(parsed.get("authors")),
        "abstract": clean_text(parsed.get("abstract")),
        "publication_year": parse_year(
            parsed.get("year") or parsed.get("publication_year")
        ),
        "venue": clean_text(parsed.get("venue")),
        "publication_type": clean_text(parsed.get("publication_type")),
        "doi": normalize_doi(parsed.get("doi")),
        "publisher_url": clean_text(parsed.get("url") or parsed.get("publisher_url")),
        "keywords": clean_text(parsed.get("keywords")),
        "isbn": clean_text(parsed.get("isbn")),
        "issn": clean_text(parsed.get("issn")),
        "pubmed_id": clean_text(parsed.get("pubmed_id")),
        "arxiv_id": clean_text(parsed.get("arxiv_id")),
    }


def normalize_imported_records(db: Session, import_batch_id: str) -> int:
    batch = db.get(ImportBatch, import_batch_id)
    if batch is None:
        raise ValueError("Import batch not found")
    records = list(
        db.scalars(
            select(ImportedRecord).where(
                ImportedRecord.import_batch_id == import_batch_id
            )
        )
    )
    created = 0
    for record in records:
        if record.validation_state != "valid":
            continue
        existing_source = db.scalar(
            select(PublicationSource).where(
                PublicationSource.imported_record_id == record.id
            )
        )
        if existing_source:
            continue
        publication = Publication(
            project_id=batch.project_id, **publication_values(record.parsed_data)
        )
        db.add(publication)
        db.flush()
        db.add(
            PublicationSource(
                publication_id=publication.id, imported_record_id=record.id
            )
        )
        created += 1
    db.flush()
    return created


def apply_enrichment(
    db: Session, publication: Publication, data: dict[str, Any], source_name: str
) -> int:
    conflicts = 0
    for field, proposed in data.items():
        if not hasattr(publication, field) or proposed in (None, "", []):
            continue
        proposed_value = (
            parse_year(proposed)
            if field == "publication_year"
            else normalize_doi(proposed)
            if field == "doi"
            else clean_text(proposed)
        )
        current = getattr(publication, field)
        if current in (None, ""):
            setattr(publication, field, proposed_value)
        elif (
            str(current).strip() != str(proposed_value).strip()
            and field in IMPORTANT_FIELDS
        ):
            already = db.scalar(
                select(MetadataConflict).where(
                    MetadataConflict.publication_id == publication.id,
                    MetadataConflict.field_name == field,
                    MetadataConflict.proposed_value == str(proposed_value),
                    MetadataConflict.status == "open",
                )
            )
            if not already:
                db.add(
                    MetadataConflict(
                        publication_id=publication.id,
                        field_name=field,
                        current_value=str(current),
                        proposed_value=str(proposed_value),
                        source_name=source_name,
                    )
                )
                conflicts += 1
    db.flush()
    return conflicts
