"""A provider that has no record and a provider that could not be reached are
different facts.

Metadata enrichment used to swallow every provider exception with a bare
``except Exception: continue``, so a Crossref outage produced a job that
completed "successfully" having enriched nothing -- and no retry.
"""

from __future__ import annotations

from typing import Any

import httpx
import pytest
from sqlalchemy import func, select

from app.accounts.service import create_user
from app.integrations.metadata import (
    CrossrefClient,
    LookupOutcome,
    MetadataLookup,
    SemanticScholarClient,
)
from app.jobs.models import BackgroundJob, JobStatus
from app.jobs.service import enqueue_job
from app.jobs.worker import execute_next_job
from app.projects.models import Project, ReviewType
from app.publications.models import MetadataConflict, Publication

CROSSREF_ITEM = {
    "message": {
        "title": ["Enriched Paper"],
        "author": [{"given": "Jane", "family": "Doe"}],
        "container-title": ["Journal of Tests"],
        "DOI": "10.1/enriched",
        "URL": "https://example.invalid/enriched",
        "type": "journal-article",
        "published-print": {"date-parts": [[2024]]},
    }
}


def use_fake_transport(monkeypatch, behaviour) -> None:
    """Replace httpx.Client so a provider call takes a scripted outcome."""

    class FakeClient:
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            pass

        def __enter__(self) -> FakeClient:
            return self

        def __exit__(self, *exc_info: Any) -> bool:
            return False

        def get(self, url: str, **kwargs: Any) -> httpx.Response:
            return behaviour(url)

    monkeypatch.setattr(httpx, "Client", FakeClient)


def responds(status_code: int, payload: Any = None):
    def behaviour(url: str) -> httpx.Response:
        return httpx.Response(
            status_code,
            json=payload if payload is not None else {},
            request=httpx.Request("GET", url),
        )

    return behaviour


def raises(exception: Exception):
    def behaviour(url: str) -> httpx.Response:
        raise exception

    return behaviour


class StubProvider:
    def __init__(self, name: str, result: MetadataLookup) -> None:
        self.name = name
        self.result = result
        self.calls = 0

    def lookup_doi(self, doi: str) -> MetadataLookup:
        self.calls += 1
        return self.result


FOUND_VENUE = MetadataLookup(
    LookupOutcome.FOUND, data={"venue": "Journal of Tests", "publication_year": 2024}
)
NOT_FOUND = MetadataLookup(LookupOutcome.NOT_FOUND, error="HTTP 404")
TIMED_OUT = MetadataLookup(
    LookupOutcome.TRANSIENT_FAILURE, error="Request timed out: read timeout"
)
BAD_REQUEST = MetadataLookup(LookupOutcome.PERMANENT_FAILURE, error="HTTP 400")


# --- provider-call classification -------------------------------------------


@pytest.mark.parametrize("client", [CrossrefClient(), SemanticScholarClient()])
def test_a_404_is_a_not_found_answer_not_a_failure(monkeypatch, client) -> None:
    use_fake_transport(monkeypatch, responds(404))

    result = client.lookup_doi("10.1/missing")

    assert result.outcome is LookupOutcome.NOT_FOUND
    assert result.is_failure is False


@pytest.mark.parametrize("client", [CrossrefClient(), SemanticScholarClient()])
def test_a_timeout_is_a_transient_failure(monkeypatch, client) -> None:
    use_fake_transport(monkeypatch, raises(httpx.ReadTimeout("read timeout")))

    result = client.lookup_doi("10.1/slow")

    assert result.outcome is LookupOutcome.TRANSIENT_FAILURE
    assert result.is_transient_failure is True


@pytest.mark.parametrize("client", [CrossrefClient(), SemanticScholarClient()])
def test_a_connection_error_is_a_transient_failure(monkeypatch, client) -> None:
    use_fake_transport(monkeypatch, raises(httpx.ConnectError("name resolution")))

    result = client.lookup_doi("10.1/unreachable")

    assert result.outcome is LookupOutcome.TRANSIENT_FAILURE
    assert "ConnectError" in (result.error or "")


@pytest.mark.parametrize("client", [CrossrefClient(), SemanticScholarClient()])
@pytest.mark.parametrize("status_code", [429, 500, 502, 503])
def test_server_side_statuses_are_transient_failures(
    monkeypatch, client, status_code
) -> None:
    use_fake_transport(monkeypatch, responds(status_code))

    assert client.lookup_doi("10.1/x").outcome is LookupOutcome.TRANSIENT_FAILURE


@pytest.mark.parametrize("client", [CrossrefClient(), SemanticScholarClient()])
@pytest.mark.parametrize("status_code", [400, 401, 403])
def test_client_side_statuses_are_permanent_failures(
    monkeypatch, client, status_code
) -> None:
    use_fake_transport(monkeypatch, responds(status_code))

    assert client.lookup_doi("10.1/x").outcome is LookupOutcome.PERMANENT_FAILURE


def test_an_unreadable_response_is_a_permanent_failure(monkeypatch) -> None:
    use_fake_transport(monkeypatch, responds(200, {"unexpected": "shape"}))

    result = CrossrefClient().lookup_doi("10.1/weird")

    assert result.outcome is LookupOutcome.PERMANENT_FAILURE
    assert "Unreadable provider response" in (result.error or "")


def test_a_successful_crossref_response_is_found_and_mapped(monkeypatch) -> None:
    use_fake_transport(monkeypatch, responds(200, CROSSREF_ITEM))

    result = CrossrefClient().lookup_doi("10.1/enriched")

    assert result.outcome is LookupOutcome.FOUND
    assert result.data is not None
    assert result.data["title"] == "Enriched Paper"
    assert result.data["authors"] == "Jane Doe"
    assert result.data["venue"] == "Journal of Tests"
    assert result.data["publication_year"] == 2024


def test_a_successful_semantic_scholar_response_is_found_and_mapped(
    monkeypatch,
) -> None:
    use_fake_transport(
        monkeypatch,
        responds(
            200,
            {
                "title": "Enriched Paper",
                "authors": [{"name": "Jane Doe"}],
                "year": 2024,
                "venue": "Journal of Tests",
                "externalIds": {"DOI": "10.1/enriched"},
                "url": "https://example.invalid/s2",
                "publicationTypes": ["JournalArticle"],
            },
        ),
    )

    result = SemanticScholarClient().lookup_doi("10.1/enriched")

    assert result.outcome is LookupOutcome.FOUND
    assert result.data is not None
    assert result.data["venue"] == "Journal of Tests"


# --- job behaviour ----------------------------------------------------------


def queue_enrichment(db) -> tuple[str, str]:
    user = create_user(db, "curator", "Curator", "secret-password", is_admin=True)
    project = Project(
        name="Review", review_type=ReviewType.SYSTEMATIC_REVIEW, random_seed="seed"
    )
    db.add(project)
    db.flush()
    publication = Publication(
        project_id=project.id, title="Enriched Paper", doi="10.1/enriched"
    )
    db.add(publication)
    db.flush()
    job = enqueue_job(
        db,
        "enrich_publication",
        {"publication_id": publication.id},
        project_id=project.id,
        created_by_id=user.id,
    )
    db.commit()
    return publication.id, job.id


def use_providers(monkeypatch, *providers: StubProvider) -> None:
    monkeypatch.setattr(
        "app.publications.jobs.metadata_providers", lambda: list(providers)
    )


def test_every_provider_answering_not_found_completes_the_job(
    db, session_factory, monkeypatch
) -> None:
    publication_id, job_id = queue_enrichment(db)
    use_providers(
        monkeypatch,
        StubProvider("crossref", NOT_FOUND),
        StubProvider("semantic_scholar", NOT_FOUND),
    )

    assert execute_next_job(session_factory, "test-worker") is True

    db.expire_all()
    job = db.get(BackgroundJob, job_id)
    assert job.status == JobStatus.COMPLETED
    assert job.result["providers"] == []
    assert job.result["outcomes"] == {
        "crossref": "not_found",
        "semantic_scholar": "not_found",
    }
    assert job.result["failures"] == {}
    assert db.get(Publication, publication_id).venue is None


def test_every_provider_failing_transiently_retries_the_job(
    db, session_factory, monkeypatch
) -> None:
    publication_id, job_id = queue_enrichment(db)
    use_providers(
        monkeypatch,
        StubProvider("crossref", TIMED_OUT),
        StubProvider(
            "semantic_scholar",
            MetadataLookup(
                LookupOutcome.TRANSIENT_FAILURE, error="ConnectError: refused"
            ),
        ),
    )

    assert execute_next_job(session_factory, "test-worker") is True

    db.expire_all()
    job = db.get(BackgroundJob, job_id)
    # Nothing was learned, so this must not be recorded as a success.
    assert job.status == JobStatus.QUEUED
    assert job.attempts == 1
    assert "No metadata provider could be reached" in (job.error_message or "")
    assert "crossref" in job.error_message
    assert "semantic_scholar" in job.error_message
    assert db.get(Publication, publication_id).venue is None


def test_a_transient_failure_alongside_a_not_found_still_retries(
    db, session_factory, monkeypatch
) -> None:
    _, job_id = queue_enrichment(db)
    use_providers(
        monkeypatch,
        StubProvider("crossref", NOT_FOUND),
        StubProvider("semantic_scholar", TIMED_OUT),
    )

    assert execute_next_job(session_factory, "test-worker") is True

    db.expire_all()
    assert db.get(BackgroundJob, job_id).status == JobStatus.QUEUED


def test_one_provider_failing_does_not_discard_the_other_provider_result(
    db, session_factory, monkeypatch
) -> None:
    publication_id, job_id = queue_enrichment(db)
    use_providers(
        monkeypatch,
        StubProvider("crossref", TIMED_OUT),
        StubProvider("semantic_scholar", FOUND_VENUE),
    )

    assert execute_next_job(session_factory, "test-worker") is True

    db.expire_all()
    job = db.get(BackgroundJob, job_id)
    assert job.status == JobStatus.COMPLETED
    assert job.result["providers"] == ["semantic_scholar"]
    assert job.result["failures"] == {"crossref": TIMED_OUT.error}
    publication = db.get(Publication, publication_id)
    assert publication.venue == "Journal of Tests"
    assert publication.publication_year == 2024


def test_permanent_failures_alone_do_not_trigger_a_retry(
    db, session_factory, monkeypatch
) -> None:
    _, job_id = queue_enrichment(db)
    use_providers(
        monkeypatch,
        StubProvider("crossref", BAD_REQUEST),
        StubProvider("semantic_scholar", BAD_REQUEST),
    )

    assert execute_next_job(session_factory, "test-worker") is True

    db.expire_all()
    job = db.get(BackgroundJob, job_id)
    # Retrying a request the provider rejected cannot help.
    assert job.status == JobStatus.COMPLETED
    assert job.result["failures"] == {
        "crossref": "HTTP 400",
        "semantic_scholar": "HTTP 400",
    }


def test_enrichment_converges_when_the_job_runs_twice(
    db, session_factory, monkeypatch
) -> None:
    """Positive/idempotency case: enrichment is safe to re-run.

    A transient failure means the whole job is retried, so applying the same
    provider answer twice must not duplicate metadata conflicts.
    """
    publication_id, job_id = queue_enrichment(db)
    db.get(Publication, publication_id).venue = "Existing venue"
    db.commit()
    use_providers(
        monkeypatch,
        StubProvider("crossref", FOUND_VENUE),
        StubProvider("semantic_scholar", NOT_FOUND),
    )

    assert execute_next_job(session_factory, "test-worker") is True
    db.expire_all()
    job = db.get(BackgroundJob, job_id)
    assert job.status == JobStatus.COMPLETED
    first_conflicts = job.result["conflicts"]

    job.status = JobStatus.QUEUED
    job.attempts = 0
    db.commit()
    assert execute_next_job(session_factory, "test-worker") is True

    db.expire_all()
    assert db.get(BackgroundJob, job_id).status == JobStatus.COMPLETED
    assert (
        db.scalar(
            select(func.count())
            .select_from(MetadataConflict)
            .where(MetadataConflict.publication_id == publication_id)
        )
        == first_conflicts
    )
    # The reviewer's own value is never overwritten by a provider.
    assert db.get(Publication, publication_id).venue == "Existing venue"
