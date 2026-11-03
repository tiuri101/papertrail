from typing import Any

from fastapi import APIRouter, Depends, status
from sqlalchemy.orm import Session

from app.accounts.models import User
from app.api.errors import DomainError, NotFoundError
from app.audit.service import record_audit
from app.conflicts.models import FinalDecision
from app.conflicts.schemas import (
    ConflictItem,
    FinalDecisionCreate,
    FinalDecisionResponse,
)
from app.conflicts.service import (
    add_resolution_reviewer,
    conflicted_publication_ids,
    record_final_decision,
    transition_if_screening_complete,
    valid_final_decision,
)
from app.db.session import get_db
from app.deduplication.service import merged_duplicate_decisions
from app.projects.dependencies import require_project_manager_csrf
from app.projects.models import ScreeningStage
from app.projects.service import get_project
from app.publications.models import Publication
from app.screening.service import current_decisions

router = APIRouter(tags=["conflict resolution"])


@router.get(
    "/projects/{project_id}/screening/{stage}/conflicts",
    response_model=list[ConflictItem],
)
def list_conflicts(
    project_id: str,
    stage: ScreeningStage,
    _: User = Depends(require_project_manager_csrf),
    db: Session = Depends(get_db),
) -> list[dict[str, Any]]:
    items = []
    for publication_id in conflicted_publication_ids(db, project_id, stage):
        publication = db.get(Publication, publication_id)
        assert publication is not None
        items.append(
            {
                "publication_id": publication_id,
                "publication": publication,
                "decisions": current_decisions(db, publication_id, stage),
                "merged_decisions": merged_duplicate_decisions(
                    db, publication_id, stage
                ),
            }
        )
    return items


@router.post(
    "/projects/{project_id}/screening/{stage}/publications/{publication_id}/final",
    response_model=FinalDecisionResponse,
)
def resolve_conflict(
    project_id: str,
    stage: ScreeningStage,
    publication_id: str,
    payload: FinalDecisionCreate,
    admin: User = Depends(require_project_manager_csrf),
    db: Session = Depends(get_db),
) -> FinalDecision:
    publication = db.get(Publication, publication_id)
    if publication is None or publication.project_id != project_id:
        raise NotFoundError("Publication not found")
    if (
        payload.resolution_method == "owner_override"
        and not (payload.note or "").strip()
    ):
        raise DomainError("A reason is required when overriding a screening decision")
    previous = valid_final_decision(db, publication_id, stage)
    final = record_final_decision(
        db,
        publication_id,
        stage,
        payload.outcome,
        payload.resolution_method,
        admin.id,
        payload.note,
    )
    transition_if_screening_complete(db, get_project(db, project_id), stage)
    is_override = payload.resolution_method == "owner_override"
    record_audit(
        db,
        action=(
            "screening.decision_overridden"
            if is_override
            else "screening.consensus_recorded"
        ),
        entity_type="final_decision",
        entity_id=final.id,
        project_id=project_id,
        actor_id=admin.id,
        summary=(
            f'Overrode {stage.value.replace("_", "/")} screening decision for "{publication.title}"'
            if is_override
            else f"Recorded final {stage.value} decision"
        ),
        metadata={
            "previousOutcome": previous.outcome.value if previous else None,
            "outcome": final.outcome.value,
            "resolutionMethod": final.resolution_method,
            "reason": payload.note,
        },
    )
    db.commit()
    return final


@router.post(
    "/projects/{project_id}/screening/{stage}/publications/{publication_id}/additional-reviewer",
    status_code=status.HTTP_201_CREATED,
)
def create_additional_review(
    project_id: str,
    stage: ScreeningStage,
    publication_id: str,
    admin: User = Depends(require_project_manager_csrf),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    publication = db.get(Publication, publication_id)
    if publication is None or publication.project_id != project_id:
        raise NotFoundError("Publication not found")
    item = add_resolution_reviewer(db, publication_id, stage)
    record_audit(
        db,
        action="screening.additional_reviewer_added",
        entity_type="screening_work_item",
        entity_id=item.id,
        project_id=project_id,
        actor_id=admin.id,
        summary=f"Added resolution reviewer for {stage.value}",
    )
    db.commit()
    return {"workItemId": item.id, "assignedReviewerId": item.assigned_reviewer_id}
