from fastapi import APIRouter, Depends, Query, status
from sqlalchemy import select
from sqlalchemy.orm import Session, joinedload

from app.accounts.models import User
from app.api.errors import ConflictError, DomainError, NotFoundError
from app.audit.service import record_audit
from app.db.session import get_db
from app.deduplication.models import (
    DuplicateCandidate,
    PublicationMerge,
    PublicationUrlCheck,
)
from app.deduplication.schemas import (
    CandidatePublication,
    CandidateResponse,
    DuplicateProgress,
    MergeRequest,
    ResolutionNote,
    ReviseRequest,
    UrlCheckOut,
)
from app.deduplication.service import (
    claim_next_duplicate,
    duplicate_review_progress,
    lock_candidate_for_update,
    mark_not_duplicate,
    merge_publications,
    release_duplicate_candidate,
    reverse_merge,
    revise_resolution,
    transition_if_duplicate_review_complete,
)
from app.jobs.models import BackgroundJob, JobStatus
from app.jobs.service import enqueue_job
from app.projects.dependencies import (
    require_project_manager_csrf,
    require_project_member_csrf,
)
from app.projects.models import ProjectStage
from app.projects.service import get_project
from app.publications.models import Publication

router = APIRouter(tags=["deduplication"])


UrlChecksByPub = dict[str, list[PublicationUrlCheck]]


def _load_url_checks(db: Session, *publication_ids: str) -> UrlChecksByPub:
    by_pub: UrlChecksByPub = {}
    if not publication_ids:
        return by_pub
    for row in db.scalars(
        select(PublicationUrlCheck)
        .where(PublicationUrlCheck.publication_id.in_(set(publication_ids)))
        .order_by(PublicationUrlCheck.url_kind)
    ):
        by_pub.setdefault(row.publication_id, []).append(row)
    return by_pub


def _candidate_publication(
    publication: Publication, checks: list[PublicationUrlCheck]
) -> CandidatePublication:
    return CandidatePublication(
        id=publication.id,
        title=publication.title,
        authors=publication.authors,
        publication_year=publication.publication_year,
        venue=publication.venue,
        doi=publication.doi,
        publisher_url=publication.publisher_url,
        url_checks=[
            UrlCheckOut(
                kind=check.url_kind,
                url=check.url,
                reachable=check.reachable,
                status_code=check.status_code,
                checked_at=check.checked_at,
            )
            for check in checks
        ],
    )


def _candidate_response(
    candidate: DuplicateCandidate,
    active_merge: PublicationMerge | None,
    url_checks: UrlChecksByPub | None = None,
) -> CandidateResponse:
    """Serialize a candidate for the review UI, folding in the resolver's
    display name, the merge a revision would undo (merged pairs), and each
    record's URL-reachability results."""
    url_checks = url_checks or {}
    return CandidateResponse(
        id=candidate.id,
        publication_a_id=candidate.publication_a_id,
        publication_b_id=candidate.publication_b_id,
        publication_a=_candidate_publication(
            candidate.publication_a, url_checks.get(candidate.publication_a_id, [])
        ),
        publication_b=_candidate_publication(
            candidate.publication_b, url_checks.get(candidate.publication_b_id, [])
        ),
        match_reasons=candidate.match_reasons,
        title_similarity=candidate.title_similarity,
        author_similarity=candidate.author_similarity,
        year_agreement=candidate.year_agreement,
        confidence=candidate.confidence,
        status=candidate.status,
        auto_resolved=candidate.auto_resolved,
        resolved_by_id=candidate.resolved_by_id,
        resolved_by_name=(
            candidate.resolved_by.display_name if candidate.resolved_by else None
        ),
        resolved_at=(
            candidate.updated_at if candidate.status != "unresolved" else None
        ),
        resolution_note=candidate.resolution_note,
        provider_recommendation=candidate.provider_recommendation,
        provider_recommended_canonical_id=(
            candidate.provider_recommended_canonical_id
        ),
        provider_recommendation_reason=candidate.provider_recommendation_reason,
        provider_recommendation_source=candidate.provider_recommendation_source,
        canonical_publication_id=(
            active_merge.canonical_publication_id if active_merge else None
        ),
        merge_id=active_merge.id if active_merge else None,
        reserved_until=candidate.reserved_until,
        reserved_by_id=candidate.reserved_by_id,
    )


def _load_candidate(
    db: Session, project_id: str, candidate_id: str, *, lock: bool = False
) -> DuplicateCandidate:
    candidate = (
        lock_candidate_for_update(db, candidate_id)
        if lock
        else db.get(DuplicateCandidate, candidate_id)
    )
    if candidate is None or candidate.project_id != project_id:
        raise NotFoundError("Duplicate candidate not found")
    return candidate


def _active_merge(db: Session, candidate_id: str) -> PublicationMerge | None:
    return db.scalar(
        select(PublicationMerge).where(
            PublicationMerge.candidate_id == candidate_id,
            PublicationMerge.reversed_at.is_(None),
        )
    )


@router.post("/projects/{project_id}/ready", status_code=status.HTTP_202_ACCEPTED)
def mark_project_ready(
    project_id: str,
    admin: User = Depends(require_project_manager_csrf),
    db: Session = Depends(get_db),
) -> dict[str, str]:
    from app.projects.checklist import project_checklist
    from app.projects.lifecycle import set_project_stage

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
    set_project_stage(
        project, ProjectStage.DUPLICATE_REVIEW, reason="project marked ready"
    )
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
) -> list[CandidateResponse]:
    candidates = list(
        db.scalars(
            select(DuplicateCandidate)
            .options(
                joinedload(DuplicateCandidate.publication_a),
                joinedload(DuplicateCandidate.publication_b),
                joinedload(DuplicateCandidate.resolved_by),
            )
            .where(DuplicateCandidate.project_id == project_id)
            .order_by(DuplicateCandidate.confidence.desc())
        )
    )
    merged_ids = [c.id for c in candidates if c.status == "merged"]
    merges: dict[str, PublicationMerge] = {}
    if merged_ids:
        for merge in db.scalars(
            select(PublicationMerge).where(
                PublicationMerge.candidate_id.in_(merged_ids),
                PublicationMerge.reversed_at.is_(None),
            )
        ):
            if merge.candidate_id is not None:
                merges[merge.candidate_id] = merge
    pub_ids = {c.publication_a_id for c in candidates} | {
        c.publication_b_id for c in candidates
    }
    url_checks = _load_url_checks(db, *pub_ids)
    return [
        _candidate_response(c, merges.get(c.id), url_checks) for c in candidates
    ]


@router.post(
    "/projects/{project_id}/duplicates/next",
    response_model=CandidateResponse | None,
)
def claim_next_candidate(
    project_id: str,
    excluded_ids: list[str] = Query(default=[], alias="excludedItemId"),
    member: User = Depends(require_project_member_csrf),
    db: Session = Depends(get_db),
) -> CandidateResponse | None:
    get_project(db, project_id)
    candidate = claim_next_duplicate(
        db, project_id, member.id, set(excluded_ids)
    )
    db.commit()
    if candidate is None:
        return None
    url_checks = _load_url_checks(
        db, candidate.publication_a_id, candidate.publication_b_id
    )
    return _candidate_response(candidate, None, url_checks)


@router.get(
    "/projects/{project_id}/duplicates/progress",
    response_model=DuplicateProgress,
)
def duplicate_progress(
    project_id: str,
    _: User = Depends(require_project_member_csrf),
    db: Session = Depends(get_db),
) -> dict[str, int]:
    get_project(db, project_id)
    return duplicate_review_progress(db, project_id)


@router.post("/projects/{project_id}/duplicates/{candidate_id}/release")
def release_candidate(
    project_id: str,
    candidate_id: str,
    member: User = Depends(require_project_member_csrf),
    db: Session = Depends(get_db),
) -> dict[str, str]:
    candidate = _load_candidate(db, project_id, candidate_id)
    release_duplicate_candidate(db, candidate, member.id)
    db.commit()
    return {"status": "released"}


@router.post(
    "/projects/{project_id}/duplicates/detect",
    status_code=status.HTTP_202_ACCEPTED,
)
def rerun_duplicate_detection(
    project_id: str,
    manager: User = Depends(require_project_manager_csrf),
    db: Session = Depends(get_db),
) -> dict[str, str]:
    project = get_project(db, project_id)
    if project.stage != ProjectStage.DUPLICATE_REVIEW:
        raise DomainError("Duplicate detection can only run during duplicate review")
    active_job = db.scalar(
        select(BackgroundJob.id).where(
            BackgroundJob.project_id == project_id,
            BackgroundJob.job_type == "detect_duplicates",
            BackgroundJob.status.in_([JobStatus.QUEUED, JobStatus.RUNNING]),
        )
    )
    if active_job is not None:
        raise ConflictError("Duplicate detection is already queued or running")
    job = enqueue_job(
        db,
        "detect_duplicates",
        {"project_id": project_id},
        project_id=project_id,
        created_by_id=manager.id,
    )
    record_audit(
        db,
        action="duplicate.detection_requeued",
        entity_type="background_job",
        entity_id=job.id,
        project_id=project_id,
        actor_id=manager.id,
        summary="Re-ran duplicate publication detection",
    )
    db.commit()
    return {"jobId": job.id, "status": job.status.value}


@router.post(
    "/projects/{project_id}/duplicates/assess",
    status_code=status.HTTP_202_ACCEPTED,
)
def rerun_candidate_assessment(
    project_id: str,
    manager: User = Depends(require_project_manager_csrf),
    db: Session = Depends(get_db),
) -> dict[str, str]:
    """Re-check candidate-record links and re-query Crossref / Semantic Scholar
    for the unresolved pairs, without re-running blocking detection."""
    project = get_project(db, project_id)
    if project.stage != ProjectStage.DUPLICATE_REVIEW:
        raise DomainError(
            "Candidate assessment can only run during duplicate review"
        )
    active_job = db.scalar(
        select(BackgroundJob.id).where(
            BackgroundJob.project_id == project_id,
            BackgroundJob.job_type == "assess_duplicate_candidates",
            BackgroundJob.status.in_([JobStatus.QUEUED, JobStatus.RUNNING]),
        )
    )
    if active_job is not None:
        raise ConflictError("Candidate assessment is already queued or running")
    job = enqueue_job(
        db,
        "assess_duplicate_candidates",
        {"project_id": project_id},
        project_id=project_id,
        created_by_id=manager.id,
    )
    record_audit(
        db,
        action="duplicate.assessment_requeued",
        entity_type="background_job",
        entity_id=job.id,
        project_id=project_id,
        actor_id=manager.id,
        summary="Re-ran duplicate candidate link/provider assessment",
    )
    db.commit()
    return {"jobId": job.id, "status": job.status.value}


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
) -> CandidateResponse:
    candidate = _load_candidate(db, project_id, candidate_id, lock=True)
    if candidate.status != "unresolved":
        raise ConflictError(
            "Duplicate candidate was already resolved by another reviewer"
        )
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
    url_checks = _load_url_checks(
        db, candidate.publication_a_id, candidate.publication_b_id
    )
    return _candidate_response(candidate, None, url_checks)


@router.post("/projects/{project_id}/duplicates/{candidate_id}/merge")
def resolve_merge(
    project_id: str,
    candidate_id: str,
    payload: MergeRequest,
    admin: User = Depends(require_project_member_csrf),
    db: Session = Depends(get_db),
) -> dict[str, str]:
    candidate = _load_candidate(db, project_id, candidate_id, lock=True)
    if candidate.status != "unresolved":
        raise ConflictError(
            "Duplicate candidate was already resolved by another reviewer"
        )
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


@router.post(
    "/projects/{project_id}/duplicates/{candidate_id}/revise",
    response_model=CandidateResponse,
)
def revise_duplicate_decision(
    project_id: str,
    candidate_id: str,
    payload: ReviseRequest,
    member: User = Depends(require_project_member_csrf),
    db: Session = Depends(get_db),
) -> CandidateResponse:
    project = get_project(db, project_id)
    candidate = _load_candidate(db, project_id, candidate_id, lock=True)
    previous_status = candidate.status
    new_merge = revise_resolution(
        db,
        project,
        candidate,
        member.id,
        payload.resolution,
        payload.canonical_publication_id,
        payload.note,
    )
    record_audit(
        db,
        action="duplicate.decision_revised",
        entity_type="duplicate_candidate",
        entity_id=candidate.id,
        project_id=project_id,
        actor_id=member.id,
        summary="Revised duplicate candidate resolution",
        metadata={
            "previousStatus": previous_status,
            "newStatus": candidate.status,
            "mergeId": new_merge.id if new_merge else None,
        },
    )
    db.commit()
    url_checks = _load_url_checks(
        db, candidate.publication_a_id, candidate.publication_b_id
    )
    return _candidate_response(
        candidate, _active_merge(db, candidate.id), url_checks
    )


@router.post("/projects/{project_id}/merges/{merge_id}/reverse")
def undo_merge(
    project_id: str,
    merge_id: str,
    admin: User = Depends(require_project_manager_csrf),
    db: Session = Depends(get_db),
) -> dict[str, str]:
    from app.projects.lifecycle import require_merge_reversal_allowed

    merge = db.get(PublicationMerge, merge_id)
    if merge is None or merge.project_id != project_id:
        raise NotFoundError("Merge not found")
    project = get_project(db, project_id)
    # Deduplication never sets project.stage itself: a merge reversal is only
    # coherent while the project is still in duplicate review, and getting
    # back there from a later stage is the lifecycle layer's job (Move Back),
    # not a silent stage reassignment from here.
    require_merge_reversal_allowed(db, project)
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
