from typing import Any

from fastapi import APIRouter, Depends, File, UploadFile, status
from fastapi.responses import FileResponse, Response
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.accounts.dependencies import get_current_user
from app.accounts.models import User
from app.api.errors import NotFoundError
from app.audit.service import record_audit
from app.conflicts.service import valid_final_decision
from app.db.session import get_db
from app.extraction.models import ExtractionResponse, ExtractionWorkItem
from app.forms.models import FormField
from app.fulltext.documents import active_document
from app.fulltext.models import PublicationDocument
from app.fulltext.storage import storage_path
from app.imports.pdf_import import (
    create_pdf_only_batch,
    process_pdf_matches,
    stage_bulk_uploads,
)
from app.jobs.service import enqueue_job
from app.projects.dependencies import require_project_member_csrf
from app.projects.models import Criterion, ScreeningStage
from app.projects.service import require_project_access
from app.publications.models import MetadataConflict, Publication
from app.publications.schemas import (
    BulkDeleteRequest,
    BulkEnrichmentRequest,
    ConflictResolve,
    ConflictResponse,
    PublicationCreate,
    PublicationResponse,
    PublicationUpdate,
)
from app.publications.service import normalize_doi, sync_new_publications_with_stage
from app.reporting.bibtex import build_bibtex_for_publications
from app.screening.service import current_decisions

router = APIRouter(tags=["publications"])


def _screening_review_details(
    db: Session, publication_id: str, stage: ScreeningStage
) -> dict[str, Any] | None:
    final = valid_final_decision(db, publication_id, stage)
    decisions = current_decisions(db, publication_id, stage)
    if final is None and not decisions:
        return None
    resolver = (
        db.get(User, final.resolved_by_id) if final and final.resolved_by_id else None
    )
    answered_criterion_ids = {
        criterion_id
        for decision in decisions
        for criterion_id in decision.criteria_answers
    }
    criteria = (
        list(
            db.scalars(
                select(Criterion)
                .where(Criterion.id.in_(answered_criterion_ids))
                .order_by(Criterion.position, Criterion.created_at)
            )
        )
        if answered_criterion_ids
        else []
    )
    return {
        "finalDecision": (
            {
                "outcome": final.outcome.value,
                "resolutionMethod": final.resolution_method,
                "note": final.note,
                "resolvedBy": resolver.display_name if resolver else None,
            }
            if final
            else None
        ),
        "criteria": [
            {
                "id": criterion.id,
                "kind": criterion.kind.value,
                "text": criterion.text,
            }
            for criterion in criteria
        ],
        "reviewerDecisions": [
            {
                "workItemId": decision.work_item_id,
                "reviewerName": decision.reviewer.display_name,
                "outcome": decision.outcome.value,
                "criteriaAnswers": decision.criteria_answers,
                "notes": decision.notes,
                "version": decision.version,
            }
            for decision in decisions
        ],
    }


def _extraction_review_details(
    db: Session, publication_id: str
) -> dict[str, Any] | None:
    item = db.scalar(
        select(ExtractionWorkItem).where(
            ExtractionWorkItem.publication_id == publication_id
        )
    )
    if item is None:
        return None
    response = db.scalar(
        select(ExtractionResponse)
        .where(
            ExtractionResponse.work_item_id == item.id,
            ExtractionResponse.is_current.is_(True),
        )
        .order_by(ExtractionResponse.created_at.desc())
    )
    reviewer = db.get(User, response.reviewer_id) if response else None
    fields = (
        list(
            db.scalars(
                select(FormField)
                .where(FormField.form_version_id == response.form_version_id)
                .order_by(FormField.position)
            )
        )
        if response
        else []
    )
    return {
        "workItemId": item.id,
        "status": item.status.value,
        "completedAt": item.completed_at,
        "response": (
            {
                "id": response.id,
                "version": response.version,
                "reviewerName": reviewer.display_name if reviewer else None,
                "answers": response.answers,
                "fields": [
                    {
                        "stableKey": field.stable_key,
                        "label": field.label,
                        "fieldType": field.field_type.value,
                        "required": field.required,
                        "options": field.options,
                    }
                    for field in fields
                ],
            }
            if response
            else None
        ),
    }


@router.get(
    "/projects/{project_id}/publications", response_model=list[PublicationResponse]
)
def list_publications(
    project_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[Publication]:
    require_project_access(db, project_id, user)
    return list(
        db.scalars(
            select(Publication)
            .options(
                selectinload(Publication.documents).joinedload(
                    PublicationDocument.uploaded_by
                ),
                selectinload(Publication.final_decisions),
                selectinload(Publication.extraction_work_item),
                selectinload(Publication.full_text_retrieval),
            )
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
) -> Publication:
    require_project_access(db, project_id, user)
    publication = db.scalar(
        select(Publication)
        .options(
            selectinload(Publication.documents).joinedload(
                PublicationDocument.uploaded_by
            ),
            selectinload(Publication.final_decisions),
            selectinload(Publication.extraction_work_item),
            selectinload(Publication.full_text_retrieval),
        )
        .where(Publication.id == publication_id)
    )
    if publication is None or publication.project_id != project_id:
        raise NotFoundError("Publication not found")
    return publication


@router.get("/projects/{project_id}/publications/{publication_id}/review-details")
def get_publication_review_details(
    project_id: str,
    publication_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    require_project_access(db, project_id, user)
    publication = db.get(Publication, publication_id)
    if publication is None or publication.project_id != project_id:
        raise NotFoundError("Publication not found")
    return {
        "screening": {
            "titleAbstract": _screening_review_details(
                db, publication_id, ScreeningStage.TITLE_ABSTRACT
            ),
            "fullText": _screening_review_details(
                db, publication_id, ScreeningStage.FULL_TEXT
            ),
        },
        "extraction": _extraction_review_details(db, publication_id),
    }


def _get_publication(db: Session, project_id: str, publication_id: str) -> Publication:
    publication = db.get(Publication, publication_id)
    if publication is None or publication.project_id != project_id:
        raise NotFoundError("Publication not found")
    return publication


@router.get("/projects/{project_id}/publications/{publication_id}/export/bib")
def export_publication_bibtex(
    project_id: str,
    publication_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Response:
    require_project_access(db, project_id, user)
    publication = _get_publication(db, project_id, publication_id)
    text, keys = build_bibtex_for_publications([publication])
    filename = f"{keys[publication.id]}.bib"
    return Response(
        content=text,
        media_type="application/x-bibtex",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/projects/{project_id}/publications/{publication_id}/export/pdf")
def export_publication_pdf(
    project_id: str,
    publication_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> FileResponse:
    require_project_access(db, project_id, user)
    publication = _get_publication(db, project_id, publication_id)
    document = active_document(db, publication_id)
    if document is None:
        raise NotFoundError("No active PDF is attached")
    path = storage_path(document.storage_key)
    if not path.is_file():
        raise NotFoundError("PDF file is unavailable")
    _, keys = build_bibtex_for_publications([publication])
    return FileResponse(
        path,
        media_type="application/pdf",
        filename=f"{keys[publication.id]}.pdf",
    )


@router.patch(
    "/projects/{project_id}/publications/{publication_id}",
    response_model=PublicationResponse,
)
def update_publication(
    project_id: str,
    publication_id: str,
    payload: PublicationUpdate,
    admin: User = Depends(require_project_member_csrf),
    db: Session = Depends(get_db),
) -> Publication:
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
    admin: User = Depends(require_project_member_csrf),
    db: Session = Depends(get_db),
) -> None:
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


@router.post("/projects/{project_id}/publications/delete")
def bulk_delete_publications(
    project_id: str,
    payload: BulkDeleteRequest,
    admin: User = Depends(require_project_member_csrf),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    publications = list(
        db.scalars(
            select(Publication).where(
                Publication.project_id == project_id,
                Publication.id.in_(payload.publication_ids),
                Publication.is_active.is_(True),
            )
        )
    )
    for publication in publications:
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
    return {"deletedCount": len(publications)}


@router.post(
    "/projects/{project_id}/publications/{publication_id}/enrich",
    status_code=status.HTTP_202_ACCEPTED,
)
def enrich_publication(
    project_id: str,
    publication_id: str,
    admin: User = Depends(require_project_member_csrf),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
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
    _: User = Depends(require_project_member_csrf),
    db: Session = Depends(get_db),
) -> list[MetadataConflict]:
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
    admin: User = Depends(require_project_member_csrf),
    db: Session = Depends(get_db),
) -> MetadataConflict:
    conflict = db.get(MetadataConflict, conflict_id)
    if conflict is None or conflict.publication.project_id != project_id:
        raise NotFoundError("Metadata conflict not found")
    if payload.accept_proposed:
        proposed_value = conflict.proposed_value
        value: str | int | None = proposed_value
        if conflict.field_name == "publication_year":
            value = int(proposed_value) if proposed_value else None
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
) -> Publication:
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
    admin: User = Depends(require_project_member_csrf),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
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


@router.post(
    "/projects/{project_id}/publications/pdfs", status_code=status.HTTP_201_CREATED
)
async def bulk_upload_publication_pdfs(
    project_id: str,
    pdfs: list[UploadFile] = File(default=[]),
    pdf_archives: list[UploadFile] = File(default=[], alias="pdfArchive"),
    admin: User = Depends(require_project_member_csrf),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    batch = create_pdf_only_batch(db, project_id, admin.id)
    await stage_bulk_uploads(db, batch, pdfs, pdf_archives)
    db.commit()
    summary = process_pdf_matches(db, batch)
    record_audit(
        db,
        action="pdf.bulk_uploaded",
        entity_type="import_batch",
        entity_id=batch.id,
        project_id=project_id,
        actor_id=admin.id,
        summary="Bulk-uploaded PDFs for matching against existing publications",
        metadata={"summary": summary},
    )
    db.commit()
    return {"importBatchId": batch.id, "summary": summary}
