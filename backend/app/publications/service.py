from __future__ import annotations

import html
import re
import unicodedata
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.audit.service import record_audit
from app.imports.models import ImportBatch, ImportedRecord
from app.integrations.metadata import LookupOutcome, metadata_providers
from app.projects.models import Project, ProjectStage
from app.publications.models import (
    ConflictStatus,
    MetadataConflict,
    Publication,
    PublicationSource,
)

IMPORTANT_FIELDS = {"doi", "title", "authors", "publication_year", "abstract", "venue"}

# Combining Unicode accents keyed by their classic LaTeX accent command,
# e.g. {\"u} -> u + combining diaeresis -> normalized to u-umlaut.
_LATEX_ACCENT_COMBINING = {
    '"': "̈",
    "'": "́",
    "`": "̀",
    "^": "̂",
    "~": "̃",
    "=": "̄",
    ".": "̇",
    "c": "̧",
    "v": "̌",
    "u": "̆",
    "H": "̋",
    "k": "̨",
    "r": "̊",
}
_LATEX_ACCENT_RE = re.compile(r'\{?\\(["\'`^~=.]|[cvuHkr])\s*\{?([A-Za-z])\}?\}?')

# LaTeX commands for characters with no separate base letter + accent.
_LATEX_SPECIAL_CHARS = {
    "ss": "ß",
    "o": "ø",
    "O": "Ø",
    "aa": "å",
    "AA": "Å",
    "l": "ł",
    "L": "Ł",
    "ae": "æ",
    "AE": "Æ",
    "oe": "œ",
    "OE": "Œ",
    "i": "ı",
    "j": "ȷ",
}
# Braces unambiguously delimit the command, so match those first; the bare form
# needs a following-letter lookahead so "\oe" isn't misread as "\o" + "e".
_LATEX_SPECIAL_BRACED_RE = re.compile(r"\{\\(ss|AA|aa|AE|ae|OE|oe|L|l|O|o|i|j)\}")
_LATEX_SPECIAL_BARE_RE = re.compile(r"\\(ss|AA|aa|AE|ae|OE|oe|L|l|O|o|i|j)(?![A-Za-z])")

# Bare braces BibTeX uses to protect capitalization of a single word/acronym,
# e.g. "{COVID-19}" or "{PTSD}" -- left over once no accent command matched.
_LATEX_BARE_BRACES_RE = re.compile(r"\{([^{}\s]+)\}")


def _replace_special_char(match: re.Match[str]) -> str:
    return _LATEX_SPECIAL_CHARS.get(match.group(1), match.group(0))


def _decode_latex_accents(text: str) -> str:
    text = _LATEX_SPECIAL_BRACED_RE.sub(_replace_special_char, text)
    text = _LATEX_SPECIAL_BARE_RE.sub(_replace_special_char, text)

    def _replace_accent(match: re.Match[str]) -> str:
        combining = _LATEX_ACCENT_COMBINING.get(match.group(1))
        if combining is None:
            return match.group(0)
        return unicodedata.normalize("NFC", match.group(2) + combining)

    text = _LATEX_ACCENT_RE.sub(_replace_accent, text)
    if "{" in text:
        previous = None
        while previous != text:
            previous = text
            text = _LATEX_BARE_BRACES_RE.sub(r"\1", text)
    return text


def sync_new_publications_with_stage(
    db: Session, project: Project, publication_ids: list[str]
) -> None:
    """Enroll publications added after draft into the project's active stage.

    Publications created while the project is in draft or duplicate review need no
    extra action here -- they're picked up naturally the next time that stage
    advances. But `create_screening_work_items` for title/abstract only runs once,
    when duplicate review completes, so a publication added afterwards would
    otherwise sit invisible to reviewers with no screening work item at all.

    A publication added once the project has moved past title/abstract screening
    -- including a completed project -- starts at title/abstract screening just
    like any other, and its own decisions carry it through full-text and
    extraction/quality via the late-inclusion backfill in
    app.conflicts.service.record_final_decision, without disturbing publications
    already past those stages or rewinding the project's own stage.
    """
    if not publication_ids:
        return
    if project.stage in (
        ProjectStage.TITLE_ABSTRACT,
        ProjectStage.FULL_TEXT,
        ProjectStage.EXTRACTION,
        ProjectStage.COMPLETED,
    ):
        from app.projects.models import ScreeningStage
        from app.screening.service import create_screening_work_items

        create_screening_work_items(
            db, project, ScreeningStage.TITLE_ABSTRACT, publication_ids=publication_ids
        )


def create_publication(
    db: Session,
    project: Project,
    values: dict[str, Any],
    *,
    actor_id: str | None,
    audit_action: str = "publication.created_manually",
) -> Publication:
    """Add a single publication outside the import pipeline -- used by both
    the web UI's "add publication" form and the browser extension's
    create-while-capturing flow. `values` are the publication's own column
    values (already validated field-by-field by the caller's request
    schema); only `doi`, if present, gets normalized here, matching every
    other write path onto `Publication.doi`."""
    values = dict(values)
    if values.get("doi"):
        values["doi"] = normalize_doi(values["doi"])
    publication = Publication(project_id=project.id, **values)
    db.add(publication)
    db.flush()
    sync_new_publications_with_stage(db, project, [publication.id])
    record_audit(
        db,
        action=audit_action,
        entity_type="publication",
        entity_id=publication.id,
        project_id=project.id,
        actor_id=actor_id,
        summary="Added publication manually",
    )
    return publication


def clean_text(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value)
    text = html.unescape(text)
    text = _decode_latex_accents(text)
    text = re.sub(r"\s+", " ", text).strip()
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
                    MetadataConflict.status == ConflictStatus.OPEN,
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


def overwrite_values_from_providers(values: dict[str, Any]) -> dict[str, Any]:
    """Look up `values["doi"]` against the same metadata providers
    `app.publications.jobs.enrich_publication_job` uses, and overwrite every
    field a match returns -- unlike `apply_enrichment` above, which only
    ever fills an *empty* field and opens a `MetadataConflict` rather than
    clobbering one that already has a value.

    Used only by the browser extension's create-while-capturing flow
    (`app.pdf_acquisition.service.create_agent_publication`): there is no
    existing publication yet to protect, so once an authoritative record is
    found for the DOI it deliberately replaces whatever the reviewer typed
    (or left blank), rather than requiring a follow-up review step. The
    general "add a publication" path -- this module's `create_publication`,
    which the web UI's manual-add form also calls -- never calls this; the
    overwrite behavior is intentionally scoped to the flow that asked for
    it, not the create path itself.

    A missing/unrecognized DOI, or no provider having a record, leaves
    `values` unchanged -- a lookup failure or a DOI nobody has heard of
    never blocks creating the publication with whatever was typed.
    """
    doi = normalize_doi(values.get("doi"))
    if not doi:
        return values
    for provider in metadata_providers():
        result = provider.lookup_doi(doi)
        if result.outcome is LookupOutcome.FOUND and result.data:
            return _overwrite_values(values, result.data)
    return values


def _overwrite_values(values: dict[str, Any], data: dict[str, Any]) -> dict[str, Any]:
    overwritten = dict(values)
    for field, proposed in data.items():
        if not hasattr(Publication, field) or proposed in (None, "", []):
            continue
        if field == "publication_year":
            overwritten[field] = parse_year(proposed)
        elif field == "doi":
            overwritten[field] = normalize_doi(proposed)
        elif field == "publisher_url":
            overwritten[field] = clean_url(proposed)
        else:
            overwritten[field] = clean_text(proposed)
    return overwritten
