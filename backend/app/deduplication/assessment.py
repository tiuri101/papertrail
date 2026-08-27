"""External-provider assist for the duplicate-review queue.

For every publication that is part of an *unresolved* duplicate candidate this
module:

* probes the record's ``publisher_url`` and its DOI URL and records whether
  each still resolves (``PublicationUrlCheck``);
* looks each side's DOI up on Crossref / Semantic Scholar. When both DOIs
  independently resolve to what is clearly the *same work*, the pair is merged
  automatically (the same audit trail a reviewer's merge leaves). Anything
  short of that is written onto the candidate as a **non-binding
  recommendation** -- "keep record A", with a reason -- that the review UI
  shows next to the reviewer's own buttons. A recommendation never marks a
  pair distinct on its own.

This is a live external-HTTP step: it runs only in the worker, never in a
request thread.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from rapidfuzz.fuzz import ratio
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.audit.service import record_audit
from app.core.config import get_settings
from app.deduplication.models import DuplicateCandidate, PublicationUrlCheck
from app.deduplication.service import (
    merge_publications,
    normalized_authors,
    normalized_title,
)
from app.integrations.metadata import LookupOutcome, metadata_providers
from app.integrations.url_health import check_url
from app.publications.models import Publication
from app.publications.service import IMPORTANT_FIELDS, normalize_doi, values_conflict

#: A provider pair is treated as the same work only when the two authoritative
#: records agree this closely. Deliberately strict -- this is the bar for
#: acting without a human.
_SAME_WORK_TITLE_RATIO = 95.0
_SAME_WORK_AUTHOR_RATIO = 85.0

_PROVIDER_LABELS = {
    "crossref": "Crossref",
    "semantic_scholar": "Semantic Scholar",
    "url_reachability": "link check",
}


def _provider_label(source: str | None) -> str:
    return _PROVIDER_LABELS.get(source or "", "Crossref / Semantic Scholar")


def _shorten(text: str | None, limit: int = 90) -> str:
    text = (text or "").strip()
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


@dataclass(frozen=True)
class _DoiAnswer:
    """What the provider chain could tell us about one DOI."""

    outcome: LookupOutcome
    source: str | None = None
    data: dict[str, Any] | None = None

    @property
    def found(self) -> bool:
        return self.outcome is LookupOutcome.FOUND and self.data is not None


@dataclass(frozen=True)
class _PairAssessment:
    #: "same_work" (auto-merge), "merge", "distinct", or "uncertain".
    recommendation: str
    reason: str
    canonical_id: str | None
    source: str


_NO_DOI = _DoiAnswer(LookupOutcome.NOT_FOUND)


def _resolve_doi(
    providers: list[Any], doi: str, cache: dict[str, _DoiAnswer]
) -> _DoiAnswer:
    """First provider with a record wins; otherwise report the least-final
    failure seen (a transient failure is retryable, NOT_FOUND is not)."""
    if doi in cache:
        return cache[doi]
    worst = LookupOutcome.NOT_FOUND
    for provider in providers:
        result = provider.lookup_doi(doi)
        if result.outcome is LookupOutcome.FOUND and result.data is not None:
            answer = _DoiAnswer(LookupOutcome.FOUND, provider.name, result.data)
            cache[doi] = answer
            return answer
        if result.outcome is LookupOutcome.TRANSIENT_FAILURE:
            worst = LookupOutcome.TRANSIENT_FAILURE
        elif (
            result.outcome is LookupOutcome.PERMANENT_FAILURE
            and worst is LookupOutcome.NOT_FOUND
        ):
            worst = LookupOutcome.PERMANENT_FAILURE
    answer = _DoiAnswer(worst)
    cache[doi] = answer
    return answer


def _match_score(publication: Publication, data: dict[str, Any]) -> int:
    """How many important fields the local record and a provider record agree
    on (used to pick which side to keep as canonical)."""
    score = 0
    for field in IMPORTANT_FIELDS:
        local = getattr(publication, field, None)
        proposed = data.get(field)
        if local in (None, "") or proposed in (None, ""):
            continue
        if not values_conflict(field, local, proposed):
            score += 1
    return score


def _pick_canonical(
    left: Publication, right: Publication, data: dict[str, Any]
) -> tuple[Publication, Publication]:
    left_score, right_score = _match_score(left, data), _match_score(right, data)
    if left_score != right_score:
        return (left, right) if left_score > right_score else (right, left)
    ordered = sorted((left, right), key=lambda p: (p.created_at, p.id))
    return ordered[0], ordered[1]


@dataclass(frozen=True)
class _UrlSummary:
    has_any: bool
    all_reachable: bool
    all_unreachable: bool


def _summarize_urls(checks: list[PublicationUrlCheck] | None) -> _UrlSummary:
    verdicts = [c.reachable for c in (checks or []) if c.reachable is not None]
    if not verdicts:
        return _UrlSummary(False, False, False)
    return _UrlSummary(
        has_any=True,
        all_reachable=all(verdicts),
        all_unreachable=not any(verdicts),
    )


def _assess_both_found(
    left: Publication,
    right: Publication,
    ans_a: _DoiAnswer,
    ans_b: _DoiAnswer,
) -> _PairAssessment:
    data_a, data_b = ans_a.data or {}, ans_b.data or {}
    source = ans_a.source or ans_b.source or "crossref"
    title_ratio = ratio(
        normalized_title(str(data_a.get("title") or "")),
        normalized_title(str(data_b.get("title") or "")),
    )
    year_a, year_b = data_a.get("publication_year"), data_b.get("publication_year")
    year_known = bool(year_a) and bool(year_b)
    year_match = year_known and year_a == year_b
    author_ratio: float | None = None
    if data_a.get("authors") and data_b.get("authors"):
        author_ratio = ratio(
            normalized_authors(str(data_a["authors"])),
            normalized_authors(str(data_b["authors"])),
        )
    same_work = (
        title_ratio >= _SAME_WORK_TITLE_RATIO
        and (not year_known or year_match)
        and (author_ratio is None or author_ratio >= _SAME_WORK_AUTHOR_RATIO)
    )
    if same_work:
        canonical, _ = _pick_canonical(left, right, data_a)
        title = data_a.get("title") or data_b.get("title")
        year_suffix = f", {year_a}" if year_a else ""
        return _PairAssessment(
            "same_work",
            f'{_provider_label(source)} resolves both DOIs to the same work '
            f'("{_shorten(str(title))}"{year_suffix}).',
            canonical.id,
            source,
        )
    diffs: list[str] = []
    if title_ratio < _SAME_WORK_TITLE_RATIO:
        diffs.append("different titles")
    if year_known and not year_match:
        diffs.append(f"years {year_a} vs {year_b}")
    if author_ratio is not None and author_ratio < _SAME_WORK_AUTHOR_RATIO:
        diffs.append("different author lists")
    return _PairAssessment(
        "distinct",
        f"{_provider_label(source)} lists these DOIs as separate works "
        f"({'; '.join(diffs) or 'no shared metadata'}).",
        None,
        source,
    )


def _assess_pair(
    left: Publication,
    right: Publication,
    ans_a: _DoiAnswer,
    ans_b: _DoiAnswer,
    url_checks: dict[str, list[PublicationUrlCheck]],
) -> _PairAssessment | None:
    """None means "could not assess, a transient failure -- retry"."""
    if ans_a.found and ans_b.found:
        return _assess_both_found(left, right, ans_a, ans_b)

    # Exactly one DOI resolves and the other is a definitive "no such record".
    if ans_a.found ^ ans_b.found:
        missing = ans_b if ans_a.found else ans_a
        if missing.outcome is LookupOutcome.NOT_FOUND:
            found_pub, dead_pub = (
                (left, right) if ans_a.found else (right, left)
            )
            found_label, dead_label = (
                ("A", "B") if ans_a.found else ("B", "A")
            )
            source = (ans_a if ans_a.found else ans_b).source or "crossref"
            dead_doi = normalize_doi(dead_pub.doi)
            reason = (
                f"Record {found_label}'s DOI resolves on {_provider_label(source)}; "
                f"record {dead_label}'s DOI ({dead_doi}) returns no record."
            )
            if _summarize_urls(url_checks.get(dead_pub.id)).all_unreachable:
                reason += f" Record {dead_label}'s links are also unreachable."
            return _PairAssessment("merge", reason, found_pub.id, source)

    # Nothing conclusive from the providers -- fall back to link reachability.
    left_urls = _summarize_urls(url_checks.get(left.id))
    right_urls = _summarize_urls(url_checks.get(right.id))
    have_url_data = left_urls.has_any or right_urls.has_any
    if left_urls.has_any and right_urls.has_any:
        if left_urls.all_reachable and right_urls.all_unreachable:
            return _PairAssessment(
                "merge", _weak_url_reason("B", "A"), left.id, "url_reachability"
            )
        if right_urls.all_reachable and left_urls.all_unreachable:
            return _PairAssessment(
                "merge", _weak_url_reason("A", "B"), right.id, "url_reachability"
            )

    # A transient failure with nothing else to go on -- worth another attempt.
    if (
        LookupOutcome.TRANSIENT_FAILURE in (ans_a.outcome, ans_b.outcome)
        and not have_url_data
    ):
        return None

    return _PairAssessment(
        "uncertain",
        "Crossref and Semantic Scholar had no usable record for either DOI, "
        "and the links did not tell the records apart.",
        None,
        "url_reachability" if have_url_data else "crossref",
    )


def _weak_url_reason(dead: str, live: str) -> str:
    return (
        f"Weak signal: record {dead}'s publisher link and DOI are unreachable, "
        f"while record {live}'s resolve. Confirm the records before merging."
    )


def _check_publication_urls(
    db: Session,
    publications: dict[str, Publication],
    existing: dict[tuple[str, str], PublicationUrlCheck],
    timeout: float,
) -> tuple[dict[str, list[PublicationUrlCheck]], int, bool, bool]:
    """Probe publisher_url + DOI URL for each publication, upserting one
    ``PublicationUrlCheck`` row per (publication, kind)."""
    by_pub: dict[str, list[PublicationUrlCheck]] = {}
    checked = 0
    any_verdict = False
    any_transient = False
    now = datetime.now(UTC)
    for publication in publications.values():
        targets: list[tuple[str, str]] = []
        if publication.publisher_url:
            targets.append(("publisher_url", publication.publisher_url))
        doi = normalize_doi(publication.doi)
        if doi:
            targets.append(("doi", f"https://doi.org/{doi}"))
        for kind, url in targets:
            health = check_url(url, timeout=timeout)
            checked += 1
            if health.reachable is None:
                any_transient = True
            else:
                any_verdict = True
            row = existing.get((publication.id, kind))
            if row is None:
                row = PublicationUrlCheck(
                    publication_id=publication.id, url_kind=kind
                )
                db.add(row)
            row.url = url
            row.reachable = health.reachable
            row.status_code = health.status_code
            row.error = health.error
            row.checked_at = now
            by_pub.setdefault(publication.id, []).append(row)
    db.flush()
    return by_pub, checked, any_verdict, any_transient


def assess_duplicate_candidates(db: Session, project_id: str) -> dict[str, Any]:
    settings = get_settings()
    candidates = list(
        db.scalars(
            select(DuplicateCandidate)
            .where(
                DuplicateCandidate.project_id == project_id,
                DuplicateCandidate.status == "unresolved",
            )
            .order_by(DuplicateCandidate.id)
        )
    )
    if not candidates:
        return {
            "candidates": 0,
            "urlsChecked": 0,
            "autoMerged": 0,
            "recommended": 0,
            "inconclusive": 0,
            "urlVerdicts": 0,
            "transientFailure": False,
        }

    pub_ids: set[str] = set()
    for candidate in candidates:
        pub_ids.add(candidate.publication_a_id)
        pub_ids.add(candidate.publication_b_id)
    publications = {
        p.id: p
        for p in db.scalars(
            select(Publication).where(Publication.id.in_(pub_ids))
        )
    }
    existing_checks = {
        (row.publication_id, row.url_kind): row
        for row in db.scalars(
            select(PublicationUrlCheck).where(
                PublicationUrlCheck.publication_id.in_(pub_ids)
            )
        )
    }

    url_checks, urls_checked, url_verdict, url_transient = _check_publication_urls(
        db, publications, existing_checks, settings.url_check_timeout_seconds
    )

    providers = metadata_providers()
    doi_cache: dict[str, _DoiAnswer] = {}
    now = datetime.now(UTC)
    auto_merged = 0
    recommended = 0
    inconclusive = 0
    provider_transient = False
    merged_away: set[str] = set()

    for candidate in candidates:
        if candidate.status != "unresolved":
            continue
        left = publications.get(candidate.publication_a_id)
        right = publications.get(candidate.publication_b_id)
        if left is None or right is None:
            continue
        if left.id in merged_away or right.id in merged_away:
            continue

        doi_a = normalize_doi(left.doi)
        doi_b = normalize_doi(right.doi)
        ans_a = _resolve_doi(providers, doi_a, doi_cache) if doi_a else _NO_DOI
        ans_b = _resolve_doi(providers, doi_b, doi_cache) if doi_b else _NO_DOI
        if LookupOutcome.TRANSIENT_FAILURE in (ans_a.outcome, ans_b.outcome):
            provider_transient = True

        assessment = _assess_pair(left, right, ans_a, ans_b, url_checks)
        if assessment is None:
            continue

        candidate.provider_recommendation = (
            "merge" if assessment.recommendation == "same_work"
            else assessment.recommendation
        )
        candidate.provider_recommended_canonical_id = assessment.canonical_id
        candidate.provider_recommendation_reason = assessment.reason
        candidate.provider_recommendation_source = assessment.source
        candidate.provider_assessed_at = now

        if assessment.recommendation == "same_work":
            assert assessment.canonical_id is not None
            merge = merge_publications(
                db, candidate, assessment.canonical_id, merged_by_id=None
            )
            candidate.auto_resolved = True
            if "provider_confirmed" not in candidate.match_reasons:
                candidate.match_reasons = [
                    *candidate.match_reasons,
                    "provider_confirmed",
                ]
            merged_away.add(merge.merged_publication_id)
            record_audit(
                db,
                action="duplicate.auto_merged",
                entity_type="publication_merge",
                entity_id=merge.id,
                project_id=project_id,
                summary="Automatically merged a provider-confirmed duplicate pair",
                metadata={
                    "canonicalPublicationId": merge.canonical_publication_id,
                    "mergedPublicationId": merge.merged_publication_id,
                    "provider": assessment.source,
                    "matchReasons": candidate.match_reasons,
                },
            )
            auto_merged += 1
        elif assessment.recommendation == "uncertain":
            inconclusive += 1
        else:
            recommended += 1

    db.flush()
    return {
        "candidates": len(candidates),
        "urlsChecked": urls_checked,
        "autoMerged": auto_merged,
        "recommended": recommended,
        "inconclusive": inconclusive,
        "urlVerdicts": int(url_verdict),
        "transientFailure": provider_transient or url_transient,
    }
