"""URL reachability + Crossref / Semantic Scholar assist for duplicate review.

A pair that ``detect_duplicates`` could not auto-merge gets one more look:
each record's links are probed and its DOI is resolved against the metadata
providers. A provider-confirmed same-work pair is merged automatically;
anything less becomes a non-binding "keep record A" hint. A recommendation
never marks a pair distinct, and a run where every provider call and every URL
probe failed transiently must fail (and retry), not report an empty success.
"""

from __future__ import annotations

from typing import Any

import httpx
import pytest
from sqlalchemy import select

from app.accounts.service import create_user
from app.audit.models import AuditEvent
from app.core.config import get_settings
from app.deduplication.assessment import assess_duplicate_candidates
from app.deduplication.jobs import assess_duplicate_candidates_job
from app.deduplication.models import (
    DuplicateCandidate,
    PublicationMerge,
    PublicationUrlCheck,
)
from app.integrations.metadata import LookupOutcome, MetadataLookup
from app.integrations.url_health import UrlHealth, check_url
from app.jobs.errors import TransientJobError
from app.jobs.models import BackgroundJob
from app.jobs.service import enqueue_job
from app.projects.models import (
    Project,
    ProjectMembership,
    ProjectStage,
    ReviewType,
)
from app.publications.models import Publication

# --------------------------------------------------------------------------
# check_url
# --------------------------------------------------------------------------


def _fake_httpx_client(monkeypatch, handler) -> None:
    """Swap httpx.Client for one whose head()/get() run a scripted handler
    ``handler(method, url) -> httpx.Response`` (or raises)."""

    class FakeClient:
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            pass

        def __enter__(self) -> FakeClient:
            return self

        def __exit__(self, *exc_info: Any) -> bool:
            return False

        def head(self, url: str, **kwargs: Any) -> httpx.Response:
            return handler("HEAD", url)

        def get(self, url: str, **kwargs: Any) -> httpx.Response:
            return handler("GET", url)

    monkeypatch.setattr(httpx, "Client", FakeClient)


def _response(status_code: int, url: str = "https://example.invalid") -> httpx.Response:
    return httpx.Response(status_code, request=httpx.Request("GET", url))


def test_check_url_reports_a_reachable_head(monkeypatch) -> None:
    _fake_httpx_client(monkeypatch, lambda method, url: _response(200))
    assert check_url("https://example.invalid/x", timeout=5) == UrlHealth(
        True, status_code=200
    )


def test_check_url_reports_an_unreachable_url_with_its_status(monkeypatch) -> None:
    _fake_httpx_client(monkeypatch, lambda method, url: _response(404))
    result = check_url("https://example.invalid/missing", timeout=5)
    assert result.reachable is False
    assert result.status_code == 404


def test_check_url_falls_back_to_get_when_head_is_rejected(monkeypatch) -> None:
    _fake_httpx_client(
        monkeypatch,
        lambda method, url: _response(200 if method == "GET" else 405),
    )
    assert check_url("https://example.invalid/x", timeout=5).reachable is True


def test_check_url_retries_with_get_after_a_head_transport_error(monkeypatch) -> None:
    def handler(method: str, url: str) -> httpx.Response:
        if method == "HEAD":
            raise httpx.ConnectError("reset", request=httpx.Request("HEAD", url))
        return _response(200)

    _fake_httpx_client(monkeypatch, handler)
    assert check_url("https://example.invalid/x", timeout=5).reachable is True


def test_check_url_returns_no_verdict_on_timeout(monkeypatch) -> None:
    def handler(method: str, url: str) -> httpx.Response:
        raise httpx.ReadTimeout("slow", request=httpx.Request(method, url))

    _fake_httpx_client(monkeypatch, handler)
    result = check_url("https://example.invalid/x", timeout=5)
    assert result.reachable is None
    assert result.status_code is None
    assert result.error


# --------------------------------------------------------------------------
# assess_duplicate_candidates
# --------------------------------------------------------------------------


class _DoiStubProvider:
    """Returns a per-DOI canned MetadataLookup (default: NOT_FOUND)."""

    def __init__(
        self,
        name: str,
        by_doi: dict[str, MetadataLookup],
        default: MetadataLookup | None = None,
    ) -> None:
        self.name = name
        self.by_doi = by_doi
        self.default = default or MetadataLookup(LookupOutcome.NOT_FOUND)
        self.calls: list[str] = []

    def lookup_doi(self, doi: str) -> MetadataLookup:
        self.calls.append(doi)
        return self.by_doi.get(doi, self.default)


def _found(title: str, year: int, authors: str = "Jane Doe") -> MetadataLookup:
    return MetadataLookup(
        LookupOutcome.FOUND,
        data={
            "title": title,
            "authors": authors,
            "publication_year": year,
            "venue": "Journal of Tests",
        },
    )


def _make_project(db) -> Project:
    project = Project(
        name="Review",
        review_type=ReviewType.SYSTEMATIC_REVIEW,
        random_seed="seed",
        stage=ProjectStage.DUPLICATE_REVIEW,
    )
    db.add(project)
    db.flush()
    return project


def _make_candidate(
    db,
    project: Project,
    *,
    a: dict[str, Any],
    b: dict[str, Any],
    match_reasons: list[str] | None = None,
    confidence: float = 0.8,
) -> DuplicateCandidate:
    pub_a = Publication(project_id=project.id, **a)
    pub_b = Publication(project_id=project.id, **b)
    db.add_all([pub_a, pub_b])
    db.flush()
    candidate = DuplicateCandidate(
        project_id=project.id,
        publication_a_id=pub_a.id,
        publication_b_id=pub_b.id,
        match_reasons=match_reasons or ["similar_title"],
        confidence=confidence,
        status="unresolved",
    )
    db.add(candidate)
    db.commit()
    return candidate


@pytest.fixture(autouse=True)
def _stub_url_checks(monkeypatch):
    """Default: every probed URL is reachable. Individual tests override."""
    monkeypatch.setattr(
        "app.deduplication.assessment.check_url",
        lambda url, *, timeout: UrlHealth(True, status_code=200),
    )


def _use_providers(monkeypatch, *providers) -> None:
    monkeypatch.setattr(
        "app.deduplication.assessment.metadata_providers",
        lambda: list(providers),
    )


def test_provider_confirmed_same_work_pair_is_auto_merged(db, monkeypatch) -> None:
    project = _make_project(db)
    candidate = _make_candidate(
        db,
        project,
        a={"title": "Urban VR: a study", "doi": "10.1/a", "publication_year": 2024},
        b={"title": "Urban VR - A Study", "doi": "10.1/b", "publication_year": 2024},
    )
    _use_providers(
        monkeypatch,
        _DoiStubProvider(
            "crossref",
            {
                "10.1/a": _found("A Study of Urban VR", 2024),
                "10.1/b": _found("A Study of Urban VR", 2024),
            },
        ),
    )

    result = assess_duplicate_candidates(db, project.id)

    db.refresh(candidate)
    assert candidate.status == "merged"
    assert candidate.auto_resolved is True
    assert "provider_confirmed" in candidate.match_reasons
    assert result["autoMerged"] == 1
    merge = db.scalar(
        select(PublicationMerge).where(PublicationMerge.candidate_id == candidate.id)
    )
    assert merge is not None
    assert candidate.provider_recommended_canonical_id in {
        candidate.publication_a_id,
        candidate.publication_b_id,
    }
    audit = db.scalar(
        select(AuditEvent).where(AuditEvent.action == "duplicate.auto_merged")
    )
    assert audit is not None


def test_auto_merging_the_last_pair_transitions_the_stage(db, monkeypatch) -> None:
    project = _make_project(db)
    _make_candidate(
        db,
        project,
        a={"title": "Only pair", "doi": "10.1/a", "publication_year": 2024},
        b={"title": "Only pair", "doi": "10.1/b", "publication_year": 2024},
    )
    _use_providers(
        monkeypatch,
        _DoiStubProvider(
            "crossref",
            {
                "10.1/a": _found("Only Pair", 2024),
                "10.1/b": _found("Only Pair", 2024),
            },
        ),
    )
    job = enqueue_job(
        db,
        "assess_duplicate_candidates",
        {"project_id": project.id},
        project_id=project.id,
        created_by_id=None,
    )
    db.flush()

    assess_duplicate_candidates_job(db, job)

    db.refresh(project)
    assert project.stage == ProjectStage.TITLE_ABSTRACT


def test_one_dead_doi_recommends_keeping_the_resolvable_record(db, monkeypatch) -> None:
    project = _make_project(db)
    candidate = _make_candidate(
        db,
        project,
        a={"title": "Signals in cities", "doi": "10.1/live", "publication_year": 2020},
        b={"title": "Signals in cities", "doi": "10.1/dead", "publication_year": 2020},
    )
    _use_providers(
        monkeypatch,
        _DoiStubProvider(
            "crossref",
            {"10.1/live": _found("Signals in Cities", 2020)},
            default=MetadataLookup(LookupOutcome.NOT_FOUND),
        ),
    )

    result = assess_duplicate_candidates(db, project.id)

    db.refresh(candidate)
    assert candidate.status == "unresolved"
    assert candidate.provider_recommendation == "merge"
    assert candidate.provider_recommended_canonical_id == candidate.publication_a_id
    assert "no record" in (candidate.provider_recommendation_reason or "")
    assert result["recommended"] == 1
    assert result["autoMerged"] == 0


def test_providers_showing_distinct_works_never_auto_marks_the_pair(
    db, monkeypatch
) -> None:
    project = _make_project(db)
    candidate = _make_candidate(
        db,
        project,
        a={"title": "Alpha study", "doi": "10.1/a", "publication_year": 2019},
        b={"title": "Alpha study", "doi": "10.1/b", "publication_year": 2019},
    )
    _use_providers(
        monkeypatch,
        _DoiStubProvider(
            "crossref",
            {
                "10.1/a": _found("Alpha: an early report", 2019),
                "10.1/b": _found("Beta: a totally separate paper", 2022),
            },
        ),
    )

    assess_duplicate_candidates(db, project.id)

    db.refresh(candidate)
    assert candidate.status == "unresolved"
    assert candidate.provider_recommendation == "distinct"
    assert candidate.provider_recommended_canonical_id is None


def test_all_transient_failures_and_no_url_verdict_fails_the_job(
    db, monkeypatch
) -> None:
    project = _make_project(db)
    _make_candidate(
        db,
        project,
        a={"title": "Paper", "doi": "10.1/a"},
        b={"title": "Paper", "doi": "10.1/b"},
    )
    _use_providers(
        monkeypatch,
        _DoiStubProvider(
            "crossref",
            {},
            default=MetadataLookup(LookupOutcome.TRANSIENT_FAILURE, error="503"),
        ),
    )
    monkeypatch.setattr(
        "app.deduplication.assessment.check_url",
        lambda url, *, timeout: UrlHealth(None, error="timeout"),
    )
    job = enqueue_job(
        db,
        "assess_duplicate_candidates",
        {"project_id": project.id},
        project_id=project.id,
        created_by_id=None,
    )
    db.flush()

    with pytest.raises(TransientJobError):
        assess_duplicate_candidates_job(db, job)


def test_assessment_is_idempotent(db, monkeypatch) -> None:
    project = _make_project(db)
    candidate = _make_candidate(
        db,
        project,
        a={"title": "Roads", "doi": "10.1/live", "publisher_url": "https://ok.invalid"},
        b={"title": "Roads", "doi": "10.1/dead"},
    )
    _use_providers(
        monkeypatch,
        _DoiStubProvider("crossref", {"10.1/live": _found("Roads", 2021)}),
    )

    first = assess_duplicate_candidates(db, project.id)
    db.refresh(candidate)
    recommendation = candidate.provider_recommendation
    second = assess_duplicate_candidates(db, project.id)

    db.refresh(candidate)
    assert candidate.provider_recommendation == recommendation
    assert first["autoMerged"] == second["autoMerged"] == 0
    rows = list(
        db.scalars(
            select(PublicationUrlCheck).where(
                PublicationUrlCheck.publication_id.in_(
                    [candidate.publication_a_id, candidate.publication_b_id]
                )
            )
        )
    )
    # pub A: publisher_url + doi; pub B: doi only -> 3 rows, not 6.
    assert len(rows) == 3


def test_url_checks_only_cover_publications_in_an_unresolved_pair(
    db, monkeypatch
) -> None:
    project = _make_project(db)
    candidate = _make_candidate(
        db,
        project,
        a={"title": "In queue", "doi": "10.1/a"},
        b={"title": "In queue", "doi": "10.1/b"},
    )
    bystander = Publication(
        project_id=project.id, title="Not in any pair", doi="10.1/z"
    )
    db.add(bystander)
    db.commit()
    _use_providers(
        monkeypatch, _DoiStubProvider("crossref", {}, default=MetadataLookup(
            LookupOutcome.NOT_FOUND
        ))
    )

    assess_duplicate_candidates(db, project.id)

    checked_pub_ids = set(
        db.scalars(select(PublicationUrlCheck.publication_id))
    )
    assert checked_pub_ids == {
        candidate.publication_a_id,
        candidate.publication_b_id,
    }


# --------------------------------------------------------------------------
# detect_duplicates_job wiring
# --------------------------------------------------------------------------


def _seed_unresolved_pair(db) -> Project:
    """Identical titles but distinct DOIs -> an ``exact_title`` candidate that
    scores 0.99 (not a strong-identifier 1.0), so it stays unresolved."""
    project = _make_project(db)
    for doi in ("10.5/a", "10.5/b"):
        db.add(
            Publication(
                project_id=project.id,
                title="A survey of tram networks",
                doi=doi,
                publication_year=2022,
            )
        )
    db.commit()
    return project


def test_detect_duplicates_job_queues_the_assessment_when_pairs_remain(
    db, monkeypatch
) -> None:
    from app.deduplication.jobs import detect_duplicates_job

    project = _seed_unresolved_pair(db)
    job = enqueue_job(
        db,
        "detect_duplicates",
        {"project_id": project.id},
        project_id=project.id,
        created_by_id=None,
    )
    db.flush()

    detect_duplicates_job(db, job)

    queued = db.scalar(
        select(BackgroundJob).where(
            BackgroundJob.job_type == "assess_duplicate_candidates",
            BackgroundJob.project_id == project.id,
        )
    )
    assert queued is not None


def test_detect_duplicates_job_skips_the_assessment_when_disabled(
    db, monkeypatch
) -> None:
    from app.deduplication.jobs import detect_duplicates_job

    monkeypatch.setattr(get_settings(), "duplicate_assessment_enabled", False)
    project = _seed_unresolved_pair(db)
    job = enqueue_job(
        db,
        "detect_duplicates",
        {"project_id": project.id},
        project_id=project.id,
        created_by_id=None,
    )
    db.flush()

    detect_duplicates_job(db, job)

    queued = db.scalar(
        select(BackgroundJob).where(
            BackgroundJob.job_type == "assess_duplicate_candidates",
        )
    )
    assert queued is None


# --------------------------------------------------------------------------
# HTTP surface
# --------------------------------------------------------------------------


def _login(client) -> str:
    response = client.post(
        "/api/v1/auth/login",
        json={"username": "admin", "password": "secret-password"},
    )
    return response.json()["csrfToken"]


def test_assess_endpoint_queues_a_job_and_rejects_a_concurrent_one(
    client, db
) -> None:
    owner = create_user(db, "admin", "Owner", "secret-password")
    project = _make_project(db)
    db.add(
        ProjectMembership(project_id=project.id, user_id=owner.id, is_owner=True)
    )
    db.commit()
    csrf = _login(client)

    first = client.post(
        f"/api/v1/projects/{project.id}/duplicates/assess",
        headers={"X-CSRF-Token": csrf},
    )
    assert first.status_code == 202
    job = db.scalar(
        select(BackgroundJob).where(
            BackgroundJob.job_type == "assess_duplicate_candidates",
            BackgroundJob.project_id == project.id,
        )
    )
    assert job is not None
    assert first.json() == {"jobId": job.id, "status": "queued"}

    second = client.post(
        f"/api/v1/projects/{project.id}/duplicates/assess",
        headers={"X-CSRF-Token": csrf},
    )
    assert second.status_code == 409


def test_candidate_response_exposes_url_checks_and_recommendation(
    client, db, monkeypatch
) -> None:
    create_user(db, "admin", "Admin", "secret-password", is_admin=True)
    project = _make_project(db)
    candidate = _make_candidate(
        db,
        project,
        a={"title": "Trains", "doi": "10.9/live"},
        b={"title": "Trains", "doi": "10.9/dead"},
    )
    _use_providers(
        monkeypatch,
        _DoiStubProvider("crossref", {"10.9/live": _found("Trains", 2020)}),
    )
    assess_duplicate_candidates(db, project.id)
    db.commit()

    csrf = _login(client)
    body = client.get(
        f"/api/v1/projects/{project.id}/duplicates",
        headers={"X-CSRF-Token": csrf},
    ).json()

    entry = next(item for item in body if item["id"] == candidate.id)
    assert entry["providerRecommendation"] == "merge"
    assert entry["providerRecommendedCanonicalId"] == candidate.publication_a_id
    kinds = {
        check["kind"]
        for pub in (entry["publicationA"], entry["publicationB"])
        for check in pub["urlChecks"]
    }
    assert "doi" in kinds
