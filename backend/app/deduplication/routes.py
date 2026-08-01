from fastapi import APIRouter, Depends, status
from sqlalchemy import select
from sqlalchemy.orm import Session, joinedload

from app.accounts.models import User
from app.api.errors import DomainError, NotFoundError
from app.audit.service import record_audit
from app.db.session import get_db
from app.deduplication.models import DuplicateCandidate, PublicationMerge
from app.deduplication.schemas import CandidateResponse, MergeRequest, ResolutionNote
from app.deduplication.service import (
    mark_not_duplicate,
    merge_publications,
    reverse_merge,
    transition_if_duplicate_review_complete,
)
from app.jobs.service import enqueue_job
from app.projects.dependencies import (
    require_project_manager_csrf,
    require_project_member_csrf,
)
from app.projects.models import ProjectStage
from app.projects.service import get_project

router = APIRouter(tags=["deduplication"])


@router.post("/projects/{project_id}/ready", status_code=status.HTTP_202_ACCEPTED)
def mark_project_ready(
    project_id: str,
    admin: User = Depends(require_project_manager_csrf),
    db: Session = Depends(get_db),
):
    from app.projects.checklist import project_checklist

    project = get_project(db, project_id)
    if project.stage != ProjectStage.DRAFT:
        raise DomainError(
            "Only draft projects can be marked ready for duplicate review"
        )
    draft_stage = next(
        stage
        for stage in project_checklist(db, project)["stages"]
        if stage["stage"] == ProjectStage.DRAFT.value
    )
    incomplete = [item["label"] for item in draft_stage["items"] if not item["done"]]
    if incomplete:
        raise DomainError(f"Complete setup before continuing: {', '.join(incomplete)}")
    project.configuration_ready = True
    project.stage = ProjectStage.DUPLICATE_REVIEW
    job = enqueue_job(
        db,
        "detect_duplicates",
        {"project_id": project.id},
        project_id=project.id,
        created_by_id=admin.id,
    )
    record_audit(
        db,
        action="project.stage_changed",
        entity_type="project",
        entity_id=project.id,
        project_id=project.id,
        actor_id=admin.id,
        summary="Moved project to duplicate review",
    )
    db.commit()
    return {"jobId": job.id, "stage": project.stage.value}


@router.get("/projects/{project_id}/duplicates", response_model=list[CandidateResponse])
def list_candidates(
    project_id: str,
    _: User = Depends(require_project_member_csrf),
    db: Session = Depends(get_db),
):
    return list(
        db.scalars(
            select(DuplicateCandidate)
            .options(
                joinedload(DuplicateCandidate.publication_a),
                joinedload(DuplicateCandidate.publication_b),
            )
            .where(DuplicateCandidate.project_id == project_id)
            .order_by(DuplicateCandidate.confidence.desc())
        )
    )


@router.post(
    "/projects/{project_id}/duplicates/{candidate_id}/not-duplicate",
    response_model=CandidateResponse,
)
def resolve_not_duplicate(
    project_id: str,
    candidate_id: str,
    payload: ResolutionNote,
    admin: User = Depends(require_project_member_csrf),
    db: Session = Depends(get_db),
):
    candidate = db.get(DuplicateCandidate, candidate_id)
    if candidate is None or candidate.project_id != project_id:
        raise NotFoundError("Duplicate candidate not found")
    mark_not_duplicate(candidate, admin.id, payload.note)
    transition_if_duplicate_review_complete(db, get_project(db, project_id))
    record_audit(
        db,
        action="duplicate.not_duplicate",
        entity_type="duplicate_candidate",
        entity_id=candidate.id,
        project_id=project_id,
        actor_id=admin.id,
        summary="Resolved duplicate candidate as distinct",
    )
    db.commit()
    return candidate


@router.post("/projects/{project_id}/duplicates/{candidate_id}/merge")
def resolve_merge(
    project_id: str,
    candidate_id: str,
    payload: MergeRequest,
    admin: User = Depends(require_project_member_csrf),
    db: Session = Depends(get_db),
):
    candidate = db.get(DuplicateCandidate, candidate_id)
    if candidate is None or candidate.project_id != project_id:
        raise NotFoundError("Duplicate candidate not found")
    merge = merge_publications(
        db, candidate, payload.canonical_publication_id, admin.id
    )
    transition_if_duplicate_review_complete(db, get_project(db, project_id))
    record_audit(
        db,
        action="duplicate.merged",
        entity_type="publication_merge",
        entity_id=merge.id,
        project_id=project_id,
        actor_id=admin.id,
        summary="Merged duplicate publications",
        metadata={
            "canonicalPublicationId": merge.canonical_publication_id,
            "mergedPublicationId": merge.merged_publication_id,
        },
    )
    db.commit()
    return {
        "mergeId": merge.id,
        "canonicalPublicationId": merge.canonical_publication_id,
    }


@router.post("/projects/{project_id}/merges/{merge_id}/reverse")
def undo_merge(
    project_id: str,
    merge_id: str,
    admin: User = Depends(require_project_manager_csrf),
    db: Session = Depends(get_db),
):
    merge = db.get(PublicationMerge, merge_id)
    if merge is None or merge.project_id != project_id:
        raise NotFoundError("Merge not found")
    project = get_project(db, project_id)
    if project.stage != ProjectStage.DUPLICATE_REVIEW:
        project.stage = ProjectStage.DUPLICATE_REVIEW
    reverse_merge(db, merge, admin.id)
    record_audit(
        db,
        action="duplicate.merge_reversed",
        entity_type="publication_merge",
        entity_id=merge.id,
        project_id=project_id,
        actor_id=admin.id,
        summary="Reversed publication merge",
    )
    db.commit()
    return {"status": "reversed"}
