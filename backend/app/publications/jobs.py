from sqlalchemy.orm import Session

from app.integrations.metadata import CrossrefClient, SemanticScholarClient
from app.jobs.models import BackgroundJob
from app.publications.models import Publication
from app.publications.service import apply_enrichment


def enrich_publication_job(db: Session, job: BackgroundJob) -> dict:
    publication = db.get(Publication, job.payload["publication_id"])
    if publication is None:
        raise ValueError("Publication not found")
    if not publication.doi:
        return {"publicationId": publication.id, "status": "no-doi"}
    conflicts = 0
    completed = []
    for name, client in (
        ("crossref", CrossrefClient()),
        ("semantic_scholar", SemanticScholarClient()),
    ):
        try:
            data = client.lookup_doi(publication.doi)
        except Exception:
            continue
        conflicts += apply_enrichment(db, publication, data, name)
        completed.append(name)
    db.commit()
    return {
        "publicationId": publication.id,
        "providers": completed,
        "conflicts": conflicts,
    }
