from __future__ import annotations

import html
import re
import unicodedata
from dataclasses import dataclass

from rapidfuzz.fuzz import ratio

from app.imports.models import ImportPdfItem
from app.publications.models import Publication


def normalize_title(value: str | None) -> str:
    text = unicodedata.normalize("NFKC", html.unescape(value or "")).casefold()
    return re.sub(r"[^\w]+", " ", text, flags=re.UNICODE).strip()


def author_tokens(value: str | None) -> set[str]:
    return {
        token
        for token in re.findall(r"[\w'-]+", (value or "").casefold())
        if len(token) > 2
    }


@dataclass(frozen=True)
class MatchResult:
    publication: Publication | None
    state: str
    candidates: list[dict[str, object]]


def match_pdf(item: ImportPdfItem, publications: list[Publication]) -> MatchResult:
    if item.detected_doi:
        doi_matches = [pub for pub in publications if pub.doi == item.detected_doi]
        candidates = [_candidate(pub, 100, "exact_doi") for pub in doi_matches]
        if len(doi_matches) == 1:
            return MatchResult(doi_matches[0], "matched", candidates)
        if len(doi_matches) > 1:
            return MatchResult(None, "ambiguous", candidates)

    detected_title = normalize_title(item.detected_title)
    filename_title = normalize_title(
        re.sub(
            r"[\W_]*\d{4}[\W_]*$", "", item.original_filename.rsplit(".", 1)[0]
        )
    )
    title = detected_title or filename_title
    if not title:
        return MatchResult(None, "unmatched", [])

    ranked: list[tuple[Publication, float, str]] = []
    for publication in publications:
        normalized = normalize_title(publication.title)
        score = float(ratio(title, normalized))
        exact = title == normalized
        year_compatible = (
            not item.detected_year
            or not publication.publication_year
            or item.detected_year == publication.publication_year
        )
        pdf_authors = author_tokens(item.detected_authors)
        pub_authors = author_tokens(publication.authors)
        author_overlap = bool(pdf_authors and pub_authors and pdf_authors & pub_authors)
        if exact and year_compatible:
            reason = "exact_metadata_title" if detected_title else "exact_filename_title"
            ranked.append((publication, 99 if detected_title else 92, reason))
        elif score >= 95 and year_compatible and author_overlap:
            ranked.append((publication, score, "strong_title_author"))

    ranked.sort(key=lambda row: (-row[1], row[0].id))
    candidates = [_candidate(pub, score, reason) for pub, score, reason in ranked[:5]]
    if not ranked:
        return MatchResult(None, "unmatched", [])
    best = ranked[0]
    tied = [row for row in ranked if abs(row[1] - best[1]) < 1]
    if len(tied) > 1:
        return MatchResult(None, "ambiguous", candidates)
    if (
        best[2] == "exact_filename_title"
        and not item.detected_year
        and not item.detected_authors
    ):
        return MatchResult(None, "ambiguous", candidates)
    return MatchResult(best[0], "matched", candidates)


def _candidate(
    publication: Publication, score: float, reason: str
) -> dict[str, object]:
    return {
        "publicationId": publication.id,
        "title": publication.title,
        "authors": publication.authors,
        "publicationYear": publication.publication_year,
        "score": round(score, 2),
        "reason": reason,
    }
