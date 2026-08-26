from typing import Any

from fastapi import APIRouter, Depends, File, Query, UploadFile, status
from fastapi.responses import FileResponse, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.accounts.dependencies import get_current_user
from app.accounts.models import User
from app.api.errors import NotFoundError
from app.audit.service import record_audit
from app.conflicts.service import valid_final_decision
from app.db.session import get_db
from app.extraction.final import get_current_final_extraction
from app.extraction.models import ExtractionResponse, ExtractionWorkItem
from app.extraction.service import (
    extraction_required_reviewers,
    slot_responses_visible,
)
from app.forms.models import FormField
from app.fulltext.documents import active_document
from app.fulltext.storage import storage_path
from app.imports.pdf_import import (
    create_pdf_only_batch,
    process_pdf_matches,
    stage_bulk_uploads,
)
from app.jobs.service import enqueue_job
from app.projects.dependencies import require_project_member_csrf
from app.projects.models import Criterion, ScreeningStage
from app.projects.service import is_project_manager, require_project_access
from app.publications.deletion import remove_publications_from_review
from app.publications.listing import (
    DEFAULT_PAGE_SIZE,
    EAGER_LOAD_OPTIONS,
    MAX_PAGE_SIZE,
    PdfStatusFilterValue,
    PublicationFilters,
    PublicationPage,
    PublicationSortKey,
    ScreeningFilterValue,
    SortDirection,
    matching_publication_ids,
    publications_page,
)
from app.publications.models import ConflictStatus, MetadataConflict, Publication
from app.publications.schemas import (
    BulkDeleteRequest,
    BulkEnrichmentRequest,
    ConflictResolve,
    ConflictResponse,
    PublicationCreate,
    PublicationIdsResponse,
    PublicationPageResponse,
    PublicationResponse,
    PublicationUpdate,
)
from app.publications.service import create_publication, normalize_doi
from app.quality.models import QualityResponse, QualityWorkItem
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
                "resolvedAt": final.created_at,
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
                "createdAt": decision.created_at,
            }
            for decision in decisions
        ],
    }


def _extraction_slot_response_payload(
    db: Session, item: ExtractionWorkItem
) -> dict[str, Any] | None:
    response = db.scalar(
        select(ExtractionResponse)
        .where(
            ExtractionResponse.work_item_id == item.id,
            ExtractionResponse.is_current.is_(True),
        )
        .order_by(ExtractionResponse.created_at.desc())
    )
    if response is None:
        return None
    reviewer = db.get(User, response.reviewer_id)
    fields = list(
        db.scalars(
            select(FormField)
            .where(FormField.form_version_id == response.form_version_id)
            .order_by(FormField.position)
        )
    )
    return {
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


def _extraction_review_details(
    db: Session, publication_id: str, viewer_id: str, is_manager: bool
) -> dict[str, Any] | None:
    """Per-slot extraction status/response for a publication, respecting
    independence: a non-manager viewer sees a sibling slot's response only
    once slot_responses_visible allows it (their own slot complete)."""
    items = list(
        db.scalars(
            select(ExtractionWorkItem)
            .where(ExtractionWorkItem.publication_id == publication_id)
            .order_by(ExtractionWorkItem.slot_number)
        )
    )
    if not items:
        return None
    required = extraction_required_reviewers(db, items[0].project_id)
    final = get_current_final_extraction(db, publication_id)
    slots = []
    for item in items:
        visible = (
            is_manager
            or item.assigned_reviewer_id == viewer_id
            or slot_responses_visible(db, item, viewer_id)
        )
        slots.append(
            {
                "slotNumber": item.slot_number,
                "workItemId": item.id,
                "status": item.status.value,
                "completedAt": item.completed_at,
                "response": (
                    _extraction_slot_response_payload(db, item) if visible else None
                ),
            }
        )
    return {
        "requiredReviewers": required,
        "slots": slots,
        "final": (
            {
                "answers": final.answers,
                "resolutionMethod": final.resolution_method,
                "resolvedAt": final.created_at,
            }
            if final is not None
            else None
        ),
    }


@router.get(
    "/projects/{project_id}/publications", response_model=PublicationPageResponse
)
def list_publications(
    project_id: str,
    search: str | None = None,
    title_abstract: ScreeningFilterValue | None = Query(
        default=None, alias="titleAbstract"
    ),
    full_text: ScreeningFilterValue | None = Query(default=None, alias="fullText"),
    pdf_status: PdfStatusFilterValue | None = Query(default=None, alias="pdfStatus"),
    sort: PublicationSortKey = "title",
    direction: SortDirection = "asc",
    page: int = Query(default=1, ge=1),
    page_size: int = Query(
        default=DEFAULT_PAGE_SIZE, ge=1, le=MAX_PAGE_SIZE, alias="pageSize"
    ),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> PublicationPage:
    """One page of a project's publications, narrowed and ordered server-side.

    This deliberately has no "give me everything" mode: the whole point is
    that a project's publication list is unbounded, and a client that can ask
    for all of it will. Bulk actions that need to span pages ask for ids
    instead, through the sibling ``/publications/ids`` endpoint.
    """
    require_project_access(db, project_id, user)
    return publications_page(
        db,
        project_id,
        filters=PublicationFilters(
            search=search,
            title_abstract=title_abstract,
            full_text=full_text,
            pdf_status=pdf_status,
        ),
        sort=sort,
        direction=direction,
        page=page,
        page_size=page_size,
    )


@router.get(
    "/projects/{project_id}/publications/ids", response_model=PublicationIdsResponse
)
def list_publication_ids(
    project_id: str,
    search: str | None = None,
    title_abstract: ScreeningFilterValue | None = Query(
        default=None, alias="titleAbstract"
    ),
    full_text: ScreeningFilterValue | None = Query(default=None, alias="fullText"),
    pdf_status: PdfStatusFilterValue | None = Query(default=None, alias="pdfStatus"),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    """Every publication id matching the same filters the list accepts.

    Registered ahead of ``/publications/{publication_id}`` so "ids" is read
    as this route rather than as a publication id.
    """
    require_project_access(db, project_id, user)
    ids = matching_publication_ids(
        db,
        project_id,
        filters=PublicationFilters(
            search=search,
            title_abstract=title_abstract,
            full_text=full_text,
            pdf_status=pdf_status,
        ),
    )
    return {"ids": ids, "total": len(ids)}


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
        .options(*EAGER_LOAD_OPTIONS)
        .where(Publication.id == publication_id)
    )
    if publication is None or publication.project_id != project_id:
        raise NotFoundError("Publication not found")
    return publication


def _quality_review_details(
    db: Session, publication_id: str
) -> dict[str, Any] | None:
    item = db.scalar(
        select(QualityWorkItem).where(
            QualityWorkItem.publication_id == publication_id
        )
    )
    if item is None:
        return None
    response = db.scalar(
        select(QualityResponse)
        .where(
            QualityResponse.work_item_id == item.id,
            QualityResponse.is_current.is_(True),
        )
        .order_by(QualityResponse.created_at.desc())
    )
    response_payload = None
    if response is not None:
        reviewer = db.get(User, response.reviewer_id)
        fields = list(
            db.scalars(
                select(FormField)
                .where(FormField.form_version_id == response.form_version_id)
                .order_by(FormField.position)
            )
        )
        response_payload = {
            "reviewerName": reviewer.display_name if reviewer else None,
            "answers": response.answers,
            "totalScore": response.total_score,
            "version": response.version,
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
    return {
        "status": item.status.value,
        "completedAt": item.completed_at,
        "response": response_payload,
    }


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
        "extraction": _extraction_review_details(
            db, publication_id, user.id, is_project_manager(db, project_id, user)
        ),
        "quality": _quality_review_details(db, publication_id),
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
    remove_publications_from_review(db, project_id, [publication])
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
    remove_publications_from_review(db, project_id, publications)
    for publication in publications:
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
                Publication.project_id == project_id,
                MetadataConflict.status == ConflictStatus.OPEN,
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
        conflict.status = ConflictStatus.ACCEPT_PROPOSED
    else:
        conflict.status = ConflictStatus.KEEP_CURRENT
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
    publication = create_publication(
        db, project, payload.model_dump(exclude_unset=True), actor_id=admin.id
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
