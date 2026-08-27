"""A duplicate merge between two records that both already have metadata
almost always produces a MetadataConflict for some "important" field, even
after normalizing away pure formatting differences -- two genuinely
different-looking values for the same fact still need a decision.

resolve_conflicts_via_providers (run in the `resolve_merge_conflicts`
background job, queued by merge_publications whenever a merge creates a
conflict) asks the same external metadata providers enrichment already uses
to try to break that tie automatically: if a provider's answer for a
conflicted field agrees with one side (after the same normalization
apply_enrichment and merge_publications use to decide there's a conflict at
all), that side wins without a reviewer. A provider that confirms neither
side, or that has no answer, leaves the conflict open exactly as before.
"""

from __future__ import annotations

from sqlalchemy import select

from app.accounts.service import create_user
from app.audit.models import AuditEvent
from app.integrations.metadata import LookupOutcome, MetadataLookup
from app.jobs.models import BackgroundJob, JobStatus
from app.jobs.service import enqueue_job
from app.jobs.worker import execute_next_job
from app.projects.models import Project, ReviewType
from app.publications.models import ConflictStatus, MetadataConflict, Publication
from app.publications.service import resolve_conflicts_via_providers


class StubProvider:
    def __init__(self, name: str, result: MetadataLookup) -> None:
        self.name = name
        self.result = result
        self.calls = 0

    def lookup_doi(self, doi: str) -> MetadataLookup:
        self.calls += 1
        return self.result


NOT_FOUND = MetadataLookup(LookupOutcome.NOT_FOUND, error="HTTP 404")
TIMED_OUT = MetadataLookup(
    LookupOutcome.TRANSIENT_FAILURE, error="Request timed out: read timeout"
)


def use_providers(monkeypatch, *providers: StubProvider) -> None:
    monkeypatch.setattr(
        "app.publications.service.metadata_providers", lambda: list(providers)
    )


def open_conflict(db, publication: Publication) -> MetadataConflict:
    return db.scalar(
        select(MetadataConflict).where(
            MetadataConflict.publication_id == publication.id
        )
    )


def merged_publication_with_conflict(
    db, *, field="venue", current="Journal of Tests", proposed="J. of Tests"
) -> Publication:
    create_user(db, "admin", "Administrator", "secret-password", is_admin=True)
    project = Project(
        name="Review", review_type=ReviewType.SYSTEMATIC_REVIEW, random_seed="seed"
    )
    db.add(project)
    db.flush()
    publication = Publication(
        project_id=project.id,
        title="A Study of Urban VR",
        doi="10.1000/same",
        **{field: current},
    )
    db.add(publication)
    db.flush()
    db.add(
        MetadataConflict(
            publication_id=publication.id,
            field_name=field,
            current_value=current,
            proposed_value=proposed,
            source_name="merge",
        )
    )
    db.commit()
    return publication


def test_a_provider_confirming_the_current_value_keeps_it(db, monkeypatch) -> None:
    publication = merged_publication_with_conflict(db)
    use_providers(
        monkeypatch,
        StubProvider(
            "crossref",
            MetadataLookup(LookupOutcome.FOUND, data={"venue": "journal of tests."}),
        ),
    )

    result = resolve_conflicts_via_providers(db, publication)
    db.commit()

    assert result["resolved"] == 1
    conflict = open_conflict(db, publication)
    assert conflict.status == ConflictStatus.KEEP_CURRENT
    assert publication.venue == "Journal of Tests"
    audit_event = db.scalar(
        select(AuditEvent).where(AuditEvent.action == "metadata_conflict.auto_resolved")
    )
    assert audit_event is not None
    assert audit_event.actor_id is None


def test_a_provider_confirming_the_proposed_value_accepts_it(db, monkeypatch) -> None:
    publication = merged_publication_with_conflict(db)
    use_providers(
        monkeypatch,
        StubProvider(
            "crossref", MetadataLookup(LookupOutcome.FOUND, data={"venue": "j of tests"})
        ),
    )

    result = resolve_conflicts_via_providers(db, publication)
    db.commit()

    assert result["resolved"] == 1
    conflict = open_conflict(db, publication)
    assert conflict.status == ConflictStatus.ACCEPT_PROPOSED
    assert publication.venue == "J. of Tests"


def test_a_provider_confirming_neither_side_leaves_the_conflict_open(db, monkeypatch) -> None:
    publication = merged_publication_with_conflict(db)
    use_providers(
        monkeypatch,
        StubProvider(
            "crossref",
            MetadataLookup(LookupOutcome.FOUND, data={"venue": "A Completely Different Venue"}),
        ),
    )

    result = resolve_conflicts_via_providers(db, publication)
    db.commit()

    assert result["resolved"] == 0
    conflict = open_conflict(db, publication)
    assert conflict.status == ConflictStatus.OPEN
    assert publication.venue == "Journal of Tests"


def test_enrichment_sourced_conflicts_are_left_for_the_provider_that_raised_them(
    db, monkeypatch
) -> None:
    """A conflict enrichment already raised against a specific provider's own
    data has already been checked against that provider; asking again (or
    asking a different provider, which never saw the original disagreement)
    is out of scope for the merge tiebreaker."""
    publication = merged_publication_with_conflict(db)
    conflict = open_conflict(db, publication)
    conflict.source_name = "crossref"
    db.commit()
    use_providers(
        monkeypatch,
        StubProvider(
            "crossref", MetadataLookup(LookupOutcome.FOUND, data={"venue": "journal of tests"})
        ),
    )

    result = resolve_conflicts_via_providers(db, publication)
    db.commit()

    assert result == {"queried": [], "resolved": 0, "transientFailure": False}
    db.refresh(conflict)
    assert conflict.status == ConflictStatus.OPEN


def test_no_doi_never_calls_a_provider(db, monkeypatch) -> None:
    publication = merged_publication_with_conflict(db)
    publication.doi = None
    db.commit()
    provider = StubProvider(
        "crossref", MetadataLookup(LookupOutcome.FOUND, data={"venue": "Journal of Tests"})
    )
    use_providers(monkeypatch, provider)

    result = resolve_conflicts_via_providers(db, publication)

    assert result == {"queried": [], "resolved": 0, "transientFailure": False}
    assert provider.calls == 0


def test_a_second_provider_is_tried_once_the_first_confirms_nothing(db, monkeypatch) -> None:
    publication = merged_publication_with_conflict(db)
    use_providers(
        monkeypatch,
        StubProvider("crossref", NOT_FOUND),
        StubProvider(
            "semantic_scholar",
            MetadataLookup(LookupOutcome.FOUND, data={"venue": "journal of tests"}),
        ),
    )

    result = resolve_conflicts_via_providers(db, publication)
    db.commit()

    assert result["queried"] == ["semantic_scholar"]
    assert result["resolved"] == 1


# --- job behaviour ------------------------------------------------------


def queue_tiebreak_job(db, publication: Publication) -> str:
    job = enqueue_job(
        db,
        "resolve_merge_conflicts",
        {"publication_id": publication.id},
        project_id=publication.project_id,
        created_by_id=None,
    )
    db.commit()
    return job.id


def test_every_provider_failing_transiently_retries_the_job(
    db, session_factory, monkeypatch
) -> None:
    publication = merged_publication_with_conflict(db)
    job_id = queue_tiebreak_job(db, publication)
    monkeypatch.setattr(
        "app.publications.service.metadata_providers",
        lambda: [StubProvider("crossref", TIMED_OUT), StubProvider("semantic_scholar", TIMED_OUT)],
    )

    assert execute_next_job(session_factory, "test-worker") is True

    db.expire_all()
    job = db.get(BackgroundJob, job_id)
    assert job.status == JobStatus.QUEUED
    assert "No metadata provider" in (job.error_message or "")
    conflict = open_conflict(db, publication)
    assert conflict.status == ConflictStatus.OPEN


def test_every_provider_answering_not_found_completes_the_job_without_retry(
    db, session_factory, monkeypatch
) -> None:
    publication = merged_publication_with_conflict(db)
    job_id = queue_tiebreak_job(db, publication)
    monkeypatch.setattr(
        "app.publications.service.metadata_providers",
        lambda: [StubProvider("crossref", NOT_FOUND), StubProvider("semantic_scholar", NOT_FOUND)],
    )

    assert execute_next_job(session_factory, "test-worker") is True

    db.expire_all()
    job = db.get(BackgroundJob, job_id)
    assert job.status == JobStatus.COMPLETED
    assert job.result["resolved"] == 0


def test_a_found_provider_resolves_the_conflict_end_to_end_through_the_worker(
    db, session_factory, monkeypatch
) -> None:
    publication = merged_publication_with_conflict(db)
    job_id = queue_tiebreak_job(db, publication)
    monkeypatch.setattr(
        "app.publications.service.metadata_providers",
        lambda: [
            StubProvider(
                "crossref", MetadataLookup(LookupOutcome.FOUND, data={"venue": "j of tests"})
            )
        ],
    )

    assert execute_next_job(session_factory, "test-worker") is True

    db.expire_all()
    job = db.get(BackgroundJob, job_id)
    assert job.status == JobStatus.COMPLETED
    assert job.result["resolved"] == 1
    assert db.get(Publication, publication.id).venue == "J. of Tests"


# --- manual bulk trigger --------------------------------------------------


def login(client) -> str:
    response = client.post(
        "/api/v1/auth/login", json={"username": "admin", "password": "secret-password"}
    )
    return response.json()["csrfToken"]


def test_bulk_resolve_queues_a_job_per_publication_with_an_open_merge_conflict(
    client, db
) -> None:
    """Covers a project deduplicated before the automatic tiebreak existed:
    merge_publications only queues resolve_merge_conflicts for merges made
    from now on, so this manual sweep is how an already-open conflict from
    an earlier merge gets the same chance at resolution."""
    publication = merged_publication_with_conflict(db)
    csrf = login(client)

    response = client.post(
        f"/api/v1/projects/{publication.project_id}/metadata-conflicts/resolve-via-provider",
        headers={"X-CSRF-Token": csrf},
    )

    assert response.status_code == 202
    assert response.json()["queuedCount"] == 1
    job = db.scalar(
        select(BackgroundJob).where(BackgroundJob.job_type == "resolve_merge_conflicts")
    )
    assert job is not None
    assert job.payload == {"publication_id": publication.id}
    assert job.project_id == publication.project_id


def test_bulk_resolve_skips_a_publication_with_no_doi(client, db) -> None:
    publication = merged_publication_with_conflict(db)
    publication.doi = None
    db.commit()
    csrf = login(client)

    response = client.post(
        f"/api/v1/projects/{publication.project_id}/metadata-conflicts/resolve-via-provider",
        headers={"X-CSRF-Token": csrf},
    )

    assert response.json()["queuedCount"] == 0
    assert (
        db.scalar(
            select(BackgroundJob).where(
                BackgroundJob.job_type == "resolve_merge_conflicts"
            )
        )
        is None
    )


def test_bulk_resolve_skips_a_conflict_not_sourced_from_a_merge(client, db) -> None:
    publication = merged_publication_with_conflict(db)
    conflict = open_conflict(db, publication)
    conflict.source_name = "crossref"
    db.commit()
    csrf = login(client)

    response = client.post(
        f"/api/v1/projects/{publication.project_id}/metadata-conflicts/resolve-via-provider",
        headers={"X-CSRF-Token": csrf},
    )

    assert response.json()["queuedCount"] == 0


def test_bulk_resolve_skips_an_already_resolved_conflict(client, db) -> None:
    publication = merged_publication_with_conflict(db)
    conflict = open_conflict(db, publication)
    conflict.status = ConflictStatus.KEEP_CURRENT
    db.commit()
    csrf = login(client)

    response = client.post(
        f"/api/v1/projects/{publication.project_id}/metadata-conflicts/resolve-via-provider",
        headers={"X-CSRF-Token": csrf},
    )

    assert response.json()["queuedCount"] == 0


def test_bulk_resolve_is_scoped_to_the_project(client, db) -> None:
    publication = merged_publication_with_conflict(db)
    other_project = Project(
        name="Other Review",
        review_type=ReviewType.SYSTEMATIC_REVIEW,
        random_seed="other-seed",
    )
    db.add(other_project)
    db.flush()
    other_publication = Publication(
        project_id=other_project.id,
        title="Unrelated Paper",
        doi="10.1/other",
        venue="Old venue",
    )
    db.add(other_publication)
    db.flush()
    db.add(
        MetadataConflict(
            publication_id=other_publication.id,
            field_name="venue",
            current_value="Old venue",
            proposed_value="New venue",
            source_name="merge",
        )
    )
    db.commit()
    csrf = login(client)

    response = client.post(
        f"/api/v1/projects/{publication.project_id}/metadata-conflicts/resolve-via-provider",
        headers={"X-CSRF-Token": csrf},
    )

    assert response.json()["queuedCount"] == 1
    job = db.scalar(
        select(BackgroundJob).where(BackgroundJob.job_type == "resolve_merge_conflicts")
    )
    assert job.payload == {"publication_id": publication.id}
