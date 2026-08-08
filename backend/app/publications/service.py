from __future__ import annotations

import re
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.errors import DomainError
from app.imports.models import ImportBatch, ImportedRecord
from app.projects.models import Project, ProjectStage
from app.publications.models import MetadataConflict, Publication, PublicationSource

IMPORTANT_FIELDS = {"doi", "title", "authors", "publication_year", "abstract", "venue"}


def sync_new_publications_with_stage(
    db: Session, project: Project, publication_ids: list[str]
) -> None:
    """Enroll publications added after draft into the project's active stage.

    Publications created while the project is in draft or duplicate review need no
    extra action here -- they're picked up naturally the next time that stage
    advances. But `create_screening_work_items` for title/abstract only runs once,
    when duplicate review completes, so a publication added afterwards would
    otherwise sit invisible to reviewers with no screening work item at all.
    Publications added once full-text retrieval has started aren't supported: those
    later stages depend on a title/abstract decision a brand-new publication
    doesn't have yet.
    """
    if not publication_ids:
        return
    if project.stage == ProjectStage.TITLE_ABSTRACT:
        from app.projects.models import ScreeningStage
        from app.screening.service import create_screening_work_items

        create_screening_work_items(
            db, project, ScreeningStage.TITLE_ABSTRACT, publication_ids=publication_ids
        )
    elif project.stage in (
        ProjectStage.FULL_TEXT,
        ProjectStage.EXTRACTION,
        ProjectStage.COMPLETED,
    ):
        raise DomainError(
            "Publications can't be added once full-text retrieval has started. "
            "Move the project back to an earlier stage first."
        )


def clean_text(value: Any) -> str | None:
    if value is None:
        return None
    text = re.sub(r"\s+", " ", str(value)).strip()
    return text or None


_URL_SCHEME = re.compile(r"^\s*([a-zA-Z][a-zA-Z0-9+.\-]*):")


def clean_url(value: Any) -> str | None:
    """Like clean_text, but drops values using a non-http(s) scheme
    (e.g. javascript:) so they can't end up rendered as a link href."""
    text = clean_text(value)
    if not text:
        return None
    match = _URL_SCHEME.match(text)
    if match and match.group(1).lower() not in ("http", "https"):
        return None
    return text


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
        "publisher_url": clean_url(parsed.get("url") or parsed.get("publisher_url")),
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
    created_ids: list[str] = []
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
        created_ids.append(publication.id)
    db.flush()
    if created_ids:
        project = db.get(Project, batch.project_id)
        assert project is not None
        sync_new_publications_with_stage(db, project, created_ids)
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
            else (
                normalize_doi(proposed)
                if field == "doi"
                else (
                    clean_url(proposed)
                    if field == "publisher_url"
                    else clean_text(proposed)
                )
            )
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
