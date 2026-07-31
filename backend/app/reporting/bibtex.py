from __future__ import annotations

import re

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.conflicts.models import FinalDecision
from app.projects.models import ScreeningStage
from app.publications.models import Publication
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


SCOPES = {"included", "excluded", "duplicates", "all_screened", "custom"}


def publications_for_scope(
    db: Session,
    project_id: str,
    scope: str,
    status_filter: dict | None = None,
) -> list[Publication]:
    if scope not in SCOPES:
        raise ValueError(f"Unsupported BibTeX export scope: {scope}")
    query = select(Publication).where(Publication.project_id == project_id)
    if scope == "included":
        ids = select(FinalDecision.publication_id).where(
            FinalDecision.project_id == project_id,
            FinalDecision.stage == ScreeningStage.FULL_TEXT,
            FinalDecision.outcome == ScreeningOutcome.INCLUDE,
            FinalDecision.is_valid.is_(True),
        )
        query = query.where(Publication.id.in_(ids))
    elif scope == "excluded":
        ids = select(FinalDecision.publication_id).where(
            FinalDecision.project_id == project_id,
            FinalDecision.outcome == ScreeningOutcome.EXCLUDE,
            FinalDecision.is_valid.is_(True),
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


def build_bibtex(
    db: Session,
    project_id: str,
    scope: str = "included",
    status_filter: dict | None = None,
) -> str:
    entries: list[str] = []
    used: set[str] = set()
    for publication in publications_for_scope(db, project_id, scope, status_filter):
        key = citation_key(publication, used)
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
        entries.append("\n".join(lines))
    return "\n\n".join(entries) + ("\n" if entries else "")
