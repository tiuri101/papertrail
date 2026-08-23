from __future__ import annotations

import re
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.conflicts.models import FinalDecision
from app.projects.models import ScreeningStage
from app.publications.models import Publication
from app.screening.cohorts import outcome_filter, outcome_filter_any_stage
from app.screening.models import ScreeningOutcome


def bibtex_escape(value: str) -> str:
    return (
        value.replace("\\", "\\textbackslash{}").replace("{", "\\{").replace("}", "\\}")
    )


def citation_key(publication: Publication, used: set[str]) -> str:
    author = (
        re.sub(
            r"[^A-Za-z0-9]",
            "",
            (publication.authors or "paper").split(",")[0].split(";")[0],
        )
        or "paper"
    )
    year = str(publication.publication_year or "nd")
    first_word = publication.title.split()[0] if publication.title else "work"
    word = re.sub(r"[^A-Za-z0-9]", "", first_word)
    base = f"{author}{year}{word}".lower()
    key = base
    counter = 2
    while key in used:
        key = f"{base}{counter}"
        counter += 1
    used.add(key)
    return key


SCOPES = {"included", "excluded", "duplicates", "all_screened", "custom", "selected"}


def publications_for_scope(
    db: Session,
    project_id: str,
    scope: str,
    status_filter: dict[str, Any] | None = None,
    publication_ids: list[str] | None = None,
) -> list[Publication]:
    if scope not in SCOPES:
        raise ValueError(f"Unsupported BibTeX export scope: {scope}")
    query = select(Publication).where(Publication.project_id == project_id)
    if scope == "selected":
        if not publication_ids:
            raise ValueError("A 'selected' scope requires at least one publication ID")
        query = query.where(Publication.id.in_(publication_ids))
    elif scope == "included":
        ids = select(FinalDecision.publication_id).where(
            outcome_filter(
                project_id, ScreeningStage.FULL_TEXT, ScreeningOutcome.INCLUDE
            )
        )
        query = query.where(Publication.id.in_(ids))
    elif scope == "excluded":
        # Not stage-scoped like outcome_filter -- "excluded" here means any
        # valid exclusion, at either screening stage.
        ids = select(FinalDecision.publication_id).where(
            outcome_filter_any_stage(project_id, ScreeningOutcome.EXCLUDE)
        )
        query = query.where(Publication.id.in_(ids))
    elif scope == "duplicates":
        query = query.where(Publication.merged_into_id.is_not(None))
    elif scope == "all_screened":
        ids = select(FinalDecision.publication_id).where(
            FinalDecision.project_id == project_id
        )
        query = query.where(Publication.id.in_(ids))
    elif scope == "custom":
        outcome = (status_filter or {}).get("outcome")
        if not outcome:
            raise ValueError(
                "A custom BibTeX scope requires a statusFilter with an outcome"
            )
        conditions = [
            FinalDecision.project_id == project_id,
            FinalDecision.is_valid.is_(True),
            FinalDecision.outcome == ScreeningOutcome(outcome),
        ]
        stage = (status_filter or {}).get("stage")
        if stage:
            conditions.append(FinalDecision.stage == ScreeningStage(stage))
        ids = select(FinalDecision.publication_id).where(*conditions)
        query = query.where(Publication.id.in_(ids))
    return list(db.scalars(query.order_by(Publication.title)))


def _bibtex_entry(publication: Publication, key: str) -> str:
    fields = {
        "title": publication.title,
        "author": publication.authors,
        "year": publication.publication_year,
        "journal": publication.venue,
        "doi": publication.doi,
        "url": publication.publisher_url,
    }
    lines = [f"@article{{{key},"]
    lines.extend(
        f"  {name} = {{{bibtex_escape(str(value))}}},"
        for name, value in fields.items()
        if value not in (None, "")
    )
    lines.append("}")
    return "\n".join(lines)


def build_bibtex_for_publications(
    publications: list[Publication],
) -> tuple[str, dict[str, str]]:
    """Build combined BibTeX text plus a publication_id -> citation_key map.

    The returned keys are reused for export filenames (e.g. a bundled PDF's
    filename) so a .bib entry and its matching PDF can be identified by name.
    """
    used: set[str] = set()
    keys: dict[str, str] = {}
    entries: list[str] = []
    for publication in publications:
        key = citation_key(publication, used)
        keys[publication.id] = key
        entries.append(_bibtex_entry(publication, key))
    text = "\n\n".join(entries) + ("\n" if entries else "")
    return text, keys


def build_bibtex(
    db: Session,
    project_id: str,
    scope: str = "included",
    status_filter: dict[str, Any] | None = None,
    publication_ids: list[str] | None = None,
) -> str:
    publications = publications_for_scope(
        db, project_id, scope, status_filter, publication_ids
    )
    text, _ = build_bibtex_for_publications(publications)
    return text
