from fastapi import APIRouter, Depends, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.accounts.dependencies import get_current_user
from app.accounts.models import User
from app.api.errors import NotFoundError
from app.audit.service import record_audit
from app.db.session import get_db
from app.jobs.service import enqueue_job
from app.projects.dependencies import (
    require_project_manager_csrf,
    require_project_member_csrf,
)
from app.projects.service import require_project_access
from app.publications.models import MetadataConflict, Publication
from app.publications.schemas import (
    BulkEnrichmentRequest,
    ConflictResolve,
    ConflictResponse,
    PublicationCreate,
    PublicationResponse,
    PublicationUpdate,
)
from app.publications.service import normalize_doi, sync_new_publications_with_stage

router = APIRouter(tags=["publications"])


@router.get(
    "/projects/{project_id}/publications", response_model=list[PublicationResponse]
)
def list_publications(
    project_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    require_project_access(db, project_id, user)
    return list(
        db.scalars(
            select(Publication)
            .where(
                Publication.project_id == project_id, Publication.is_active.is_(True)
            )
            .order_by(Publication.title)
        )
    )


@router.get(
    "/projects/{project_id}/publications/{publication_id}",
    response_model=PublicationResponse,
)
def get_publication(
    project_id: str,
    publication_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    require_project_access(db, project_id, user)
    publication = db.get(Publication, publication_id)
    if publication is None or publication.project_id != project_id:
        raise NotFoundError("Publication not found")
    return publication


@router.patch(
    "/projects/{project_id}/publications/{publication_id}",
    response_model=PublicationResponse,
)
def update_publication(
    project_id: str,
    publication_id: str,
    payload: PublicationUpdate,
    admin: User = Depends(require_project_manager_csrf),
    db: Session = Depends(get_db),
):
    publication = db.get(Publication, publication_id)
    if publication is None or publication.project_id != project_id:
        raise NotFoundError("Publication not found")
    changed_fields = list(payload.model_dump(exclude_unset=True))
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(publication, field, normalize_doi(value) if field == "doi" else value)
    record_audit(
        db,
        action="publication.updated",
        entity_type="publication",
        entity_id=publication.id,
        project_id=project_id,
        actor_id=admin.id,
        summary="Updated publication metadata",
        metadata={"fields": changed_fields},
    )
    db.commit()
    return publication


@router.delete(
    "/projects/{project_id}/publications/{publication_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def delete_publication(
    project_id: str,
    publication_id: str,
    admin: User = Depends(require_project_manager_csrf),
    db: Session = Depends(get_db),
):
    publication = db.get(Publication, publication_id)
    if (
        publication is None
        or publication.project_id != project_id
        or not publication.is_active
    ):
        raise NotFoundError("Publication not found")
    publication.is_active = False
    record_audit(
        db,
        action="publication.deleted",
        entity_type="publication",
        entity_id=publication.id,
        project_id=project_id,
        actor_id=admin.id,
        summary=f"Deleted publication {publication.title}",
    )
    db.commit()


@router.post(
    "/projects/{project_id}/publications/{publication_id}/enrich",
    status_code=status.HTTP_202_ACCEPTED,
)
def enrich_publication(
    project_id: str,
    publication_id: str,
    admin: User = Depends(require_project_manager_csrf),
    db: Session = Depends(get_db),
):
    publication = db.get(Publication, publication_id)
    if publication is None or publication.project_id != project_id:
        raise NotFoundError("Publication not found")
    job = enqueue_job(
        db,
        "enrich_publication",
        {"publication_id": publication.id},
        project_id=project_id,
        created_by_id=admin.id,
    )
    record_audit(
        db,
        action="metadata_enrichment.queued",
        entity_type="publication",
        entity_id=publication.id,
        project_id=project_id,
        actor_id=admin.id,
        summary="Queued metadata enrichment",
    )
    db.commit()
    return {"jobId": job.id}


@router.get(
    "/projects/{project_id}/metadata-conflicts", response_model=list[ConflictResponse]
)
def list_conflicts(
    project_id: str,
    _: User = Depends(require_project_manager_csrf),
    db: Session = Depends(get_db),
):
    return list(
        db.scalars(
            select(MetadataConflict)
            .join(Publication)
            .where(
                Publication.project_id == project_id, MetadataConflict.status == "open"
            )
        )
    )


@router.post(
    "/projects/{project_id}/metadata-conflicts/{conflict_id}/resolve",
    response_model=ConflictResponse,
)
def resolve_conflict(
    project_id: str,
    conflict_id: str,
    payload: ConflictResolve,
    admin: User = Depends(require_project_manager_csrf),
    db: Session = Depends(get_db),
):
    conflict = db.get(MetadataConflict, conflict_id)
    if conflict is None or conflict.publication.project_id != project_id:
        raise NotFoundError("Metadata conflict not found")
    if payload.accept_proposed:
        value = conflict.proposed_value
        if conflict.field_name == "publication_year":
            value = int(value) if value else None
        setattr(conflict.publication, conflict.field_name, value)
        conflict.status = "accept_proposed"
    else:
        conflict.status = "keep_current"
    record_audit(
        db,
        action="metadata_conflict.resolved",
        entity_type="metadata_conflict",
        entity_id=conflict.id,
        project_id=project_id,
        actor_id=admin.id,
        summary=f"Resolved metadata conflict for {conflict.field_name}",
        metadata={"resolution": conflict.status},
    )
    db.commit()
    return conflict


@router.post(
    "/projects/{project_id}/publications",
    response_model=PublicationResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_manual_publication(
    project_id: str,
    payload: PublicationCreate,
    admin: User = Depends(require_project_member_csrf),
    db: Session = Depends(get_db),
):
    project = require_project_access(db, project_id, admin)
    values = payload.model_dump(exclude_unset=True)
    if values.get("doi"):
        values["doi"] = normalize_doi(values["doi"])
    publication = Publication(project_id=project_id, **values)
    db.add(publication)
    db.flush()
    sync_new_publications_with_stage(db, project, [publication.id])
    record_audit(
        db,
        action="publication.created_manually",
        entity_type="publication",
        entity_id=publication.id,
        project_id=project_id,
        actor_id=admin.id,
        summary="Added publication manually",
    )
    db.commit()
    return publication


@router.post(
    "/projects/{project_id}/publications/enrich", status_code=status.HTTP_202_ACCEPTED
)
def bulk_enrich_publications(
    project_id: str,
    payload: BulkEnrichmentRequest,
    admin: User = Depends(require_project_manager_csrf),
    db: Session = Depends(get_db),
):
    require_project_access(db, project_id, admin)
    query = select(Publication).where(
        Publication.project_id == project_id,
        Publication.is_active.is_(True),
    )
    if payload.publication_ids is not None:
        query = query.where(Publication.id.in_(payload.publication_ids))
    if payload.missing_only:
        query = query.where(
            (Publication.abstract.is_(None))
            | (Publication.authors.is_(None))
            | (Publication.venue.is_(None))
        )
    publications = list(db.scalars(query))
    jobs = [
        enqueue_job(
            db,
            "enrich_publication",
            {"publication_id": publication.id},
            project_id=project_id,
            created_by_id=admin.id,
        )
        for publication in publications
        if publication.doi
    ]
    record_audit(
        db,
        action="metadata_enrichment.bulk_queued",
        entity_type="project",
        entity_id=project_id,
        project_id=project_id,
        actor_id=admin.id,
        summary=f"Queued metadata enrichment for {len(jobs)} publications",
    )
    db.commit()
    return {"jobIds": [job.id for job in jobs]}
