from typing import Any

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.accounts.dependencies import require_csrf
from app.accounts.models import User, UserSession
from app.api.errors import NotFoundError
from app.audit.service import record_audit
from app.db.session import get_db
from app.fulltext.models import FullTextRetrieval, RetrievalStatus
from app.fulltext.schemas import (
    RetrievalProgressResponse,
    RetrievalResponse,
    RetrievalUpdate,
)
from app.fulltext.service import (
    claim_next_retrieval,
    release_retrieval_claim,
    resolve_retrieval,
    retrieval_progress,
    transition_if_full_text_complete,
)
from app.projects.dependencies import require_full_text_reviewer_csrf
from app.projects.service import (
    get_project,
    is_project_manager,
    require_project_access,
)

router = APIRouter(tags=["full text"])


@router.post(
    "/projects/{project_id}/full-text/next",
    response_model=RetrievalResponse | None,
)
def next_retrieval(
    project_id: str,
    excluded_retrieval_ids: list[str] = Query(default=[], alias="excludedRetrievalId"),
    reviewer: User = Depends(require_full_text_reviewer_csrf),
    db: Session = Depends(get_db),
) -> FullTextRetrieval | None:
    retrieval = claim_next_retrieval(
        db, project_id, reviewer.id, set(excluded_retrieval_ids)
    )
    db.commit()
    return retrieval


@router.post("/projects/{project_id}/full-text/{retrieval_id}/release")
def release_retrieval(
    project_id: str,
    retrieval_id: str,
    session: UserSession = Depends(require_csrf),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    retrieval = db.get(FullTextRetrieval, retrieval_id)
    if retrieval is None or retrieval.project_id != project_id:
        raise NotFoundError("Full-text retrieval record not found")
    release_retrieval_claim(retrieval, session.user.id)
    db.commit()
    return {"status": "released"}


@router.get(
    "/projects/{project_id}/full-text/progress",
    response_model=RetrievalProgressResponse,
)
def full_text_progress(
    project_id: str,
    session: UserSession = Depends(require_csrf),
    db: Session = Depends(get_db),
) -> dict[str, int]:
    require_project_access(db, project_id, session.user)
    return retrieval_progress(db, project_id)


@router.put(
    "/projects/{project_id}/full-text/{retrieval_id}", response_model=RetrievalResponse
)
def update_retrieval(
    project_id: str,
    retrieval_id: str,
    payload: RetrievalUpdate,
    reviewer: User = Depends(require_full_text_reviewer_csrf),
    db: Session = Depends(get_db),
) -> FullTextRetrieval:
    retrieval = db.get(FullTextRetrieval, retrieval_id)
    if retrieval is None or retrieval.project_id != project_id:
        raise NotFoundError("Full-text retrieval record not found")
    decision = resolve_retrieval(
        db,
        retrieval,
        RetrievalStatus(payload.status),
        note=payload.note,
        user_id=reviewer.id,
        # Managers administer the retrieval queue and correct records nobody
        # has claimed; ordinary reviewers must hold the claim themselves.
        is_manager=is_project_manager(db, project_id, reviewer),
        decision_outcome=payload.decision.outcome if payload.decision else None,
        decision_criteria_answers=(
            payload.decision.criteria_answers if payload.decision else None
        ),
        decision_notes=payload.decision.notes if payload.decision else None,
    )
    transition_if_full_text_complete(db, get_project(db, project_id))
    record_audit(
        db,
        action="fulltext.status_changed",
        entity_type="full_text_retrieval",
        entity_id=retrieval.id,
        project_id=project_id,
        actor_id=reviewer.id,
        summary=f"Set full-text retrieval status to {retrieval.status.value}",
    )
    if decision is not None:
        record_audit(
            db,
            action="screening.decision_submitted",
            entity_type="screening_decision",
            entity_id=decision.id,
            project_id=project_id,
            actor_id=reviewer.id,
            summary="Submitted full_text screening decision",
            metadata={
                "outcome": decision.outcome.value,
                "version": decision.version,
                "criteriaAnswers": decision.criteria_answers,
            },
        )
    retrieval.decision_submitted = decision is not None  # type: ignore[attr-defined]
    db.commit()
    return retrieval
