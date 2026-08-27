from typing import Any

from sqlalchemy.orm import Session

from app.integrations.metadata import LookupOutcome, metadata_providers
from app.jobs.errors import TransientJobError
from app.jobs.models import BackgroundJob
from app.publications.models import Publication
from app.publications.service import apply_enrichment, resolve_conflicts_via_providers


def enrich_publication_job(db: Session, job: BackgroundJob) -> dict[str, Any]:
    """Fill in a publication's missing metadata from the external providers.

    Re-running this is safe: `apply_enrichment` only fills fields that are
    still empty and will not open a second identical metadata conflict, so a
    retry converges on the same state.

    A provider that legitimately has no record for the DOI is a real answer
    and must not fail the job. A provider that timed out, refused the
    connection, or returned 5xx told us nothing, so if that is all we got the
    job must fail and be retried rather than report a successful enrichment
    that never happened.
    """
    publication = db.get(Publication, job.payload["publication_id"])
    if publication is None:
        raise ValueError("Publication not found")
    if not publication.doi:
        return {"publicationId": publication.id, "status": "no-doi"}
    conflicts = 0
    enriched: list[str] = []
    outcomes: dict[str, str] = {}
    failures: dict[str, str] = {}
    transient_failure = False
    for provider in metadata_providers():
        result = provider.lookup_doi(publication.doi)
        outcomes[provider.name] = result.outcome.value
        if result.outcome is LookupOutcome.FOUND and result.data is not None:
            conflicts += apply_enrichment(db, publication, result.data, provider.name)
            enriched.append(provider.name)
            continue
        if result.is_failure:
            failures[provider.name] = result.error or result.outcome.value
            transient_failure = transient_failure or result.is_transient_failure

    if not enriched and transient_failure:
        # Nothing was applied, so there is nothing to keep; let the worker's
        # normal retry policy try again rather than closing the job as a
        # success that enriched nothing.
        detail = "; ".join(f"{name}: {error}" for name, error in failures.items())
        raise TransientJobError(f"No metadata provider could be reached ({detail})")

    db.commit()
    return {
        "publicationId": publication.id,
        "providers": enriched,
        "outcomes": outcomes,
        "failures": failures,
        "conflicts": conflicts,
    }


def resolve_merge_conflicts_job(db: Session, job: BackgroundJob) -> dict[str, Any]:
    """Try to break a tie on the metadata conflicts a duplicate merge just
    created, using the same external providers enrichment draws on.

    Re-running this is safe: it only ever acts on conflicts still OPEN, so a
    conflict a previous run (or a reviewer) already resolved is left alone.

    A provider that legitimately has no record for the DOI is a real answer,
    not a failure -- the conflicts just stay open for a reviewer. Only a
    provider that could not be reached at all is worth retrying for.
    """
    publication = db.get(Publication, job.payload["publication_id"])
    if publication is None:
        return {"publicationId": job.payload["publication_id"], "status": "not-found"}
    result = resolve_conflicts_via_providers(db, publication)
    if result["transientFailure"]:
        raise TransientJobError(
            "No metadata provider could be reached to resolve merge conflicts"
        )
    db.commit()
    return {"publicationId": publication.id, **result}
