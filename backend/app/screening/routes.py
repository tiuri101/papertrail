from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.accounts.dependencies import get_current_user, require_csrf
from app.accounts.models import User, UserSession
from app.api.errors import NotFoundError
from app.audit.service import record_audit
from app.db.session import get_db
from app.projects.models import Criterion, ScreeningStage
from app.projects.service import get_project, require_project_access
from app.publications.models import Publication
from app.screening.models import ScreeningWorkItem
from app.screening.schemas import (
    DecisionResponse,
    DecisionSubmit,
    DraftUpdate,
    MyDecisionsResponse,
    WorkItemResponse,
)
from app.screening.service import (
    claim_next_work_item,
    current_decisions,
    my_submitted_work_items,
    release_work_item,
    save_draft,
    stage_completed,
    submit_decision,
)

router = APIRouter(tags=["screening"])


def work_item_payload(db: Session, item: ScreeningWorkItem) -> dict:
    publication = db.get(Publication, item.publication_id)
    criteria = list(
        db.scalars(
            select(Criterion)
            .where(
                Criterion.project_id == item.project_id, Criterion.is_active.is_(True)
            )
            .order_by(Criterion.position)
        )
    )
    return {
        "id": item.id,
        "project_id": item.project_id,
        "stage": item.stage.value,
        "slot_number": item.slot_number,
        "reserved_until": item.reserved_until.isoformat()
        if item.reserved_until
        else None,
        "draft": item.draft,
        "publication": publication,
        "criteria": criteria,
    }


@router.post(
    "/projects/{project_id}/screening/{stage}/next",
    response_model=WorkItemResponse | None,
)
def next_item(
    project_id: str,
    stage: ScreeningStage,
    session: UserSession = Depends(require_csrf),
    db: Session = Depends(get_db),
):
    require_project_access(db, project_id, session.user)
    item = claim_next_work_item(db, project_id, stage, session.user.id)
    db.commit()
    return work_item_payload(db, item) if item else None


@router.put("/projects/{project_id}/screening/work-items/{item_id}/draft")
def update_draft(
    project_id: str,
    item_id: str,
    payload: DraftUpdate,
    session: UserSession = Depends(require_csrf),
    db: Session = Depends(get_db),
):
    item = db.get(ScreeningWorkItem, item_id)
    if item is None or item.project_id != project_id:
        raise NotFoundError("Screening work item not found")
    save_draft(item, session.user.id, payload.draft)
    db.commit()
    return {"status": "saved"}


@router.post("/projects/{project_id}/screening/work-items/{item_id}/release")
def release_item(
    project_id: str,
    item_id: str,
    session: UserSession = Depends(require_csrf),
    db: Session = Depends(get_db),
):
    item = db.get(ScreeningWorkItem, item_id)
    if item is None or item.project_id != project_id:
        raise NotFoundError("Screening work item not found")
    release_work_item(item, session.user.id)
    db.commit()
    return {"status": "released"}


@router.post(
    "/projects/{project_id}/screening/work-items/{item_id}/decision",
    response_model=DecisionResponse,
)
def decide(
    project_id: str,
    item_id: str,
    payload: DecisionSubmit,
    session: UserSession = Depends(require_csrf),
    db: Session = Depends(get_db),
):
    item = db.get(ScreeningWorkItem, item_id)
    if item is None or item.project_id != project_id:
        raise NotFoundError("Screening work item not found")
    project = get_project(db, project_id)
    was_stage_completed = stage_completed(project, item.stage)
    decision = submit_decision(
        db,
        item,
        session.user.id,
        payload.outcome,
        payload.criteria_answers,
        payload.notes,
    )
    from app.conflicts.service import (
        refresh_automatic_final_decision,
        transition_if_screening_complete,
    )

    refresh_automatic_final_decision(db, item.publication_id, item.stage)
    transition_if_screening_complete(db, project, item.stage)
    record_audit(
        db,
        action="screening.decision_submitted",
        entity_type="screening_decision",
        entity_id=decision.id,
        project_id=project_id,
        actor_id=session.user.id,
        summary=(
            f"Submitted {item.stage.value} screening decision"
            if decision.version == 1
            else f"Revised {item.stage.value} screening decision"
            + (" after stage completion" if was_stage_completed else "")
        ),
        metadata={
            "outcome": decision.outcome.value,
            "version": decision.version,
            "criteriaAnswers": decision.criteria_answers,
            "revisedAfterStageCompletion": was_stage_completed,
        },
    )
    db.commit()
    return decision


@router.get(
    "/projects/{project_id}/screening/{stage}/publications/{publication_id}/decisions",
    response_model=list[DecisionResponse],
)
def revealed_decisions(
    project_id: str,
    stage: ScreeningStage,
    publication_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    require_project_access(db, project_id, user)
    return current_decisions(db, publication_id, stage)


@router.get(
    "/projects/{project_id}/screening/{stage}/my-decisions",
    response_model=MyDecisionsResponse,
)
def my_decisions(
    project_id: str,
    stage: ScreeningStage,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    project = require_project_access(db, project_id, user)
    items = my_submitted_work_items(db, project_id, stage, user.id)
    criteria = list(
        db.scalars(
            select(Criterion)
            .where(Criterion.project_id == project_id, Criterion.is_active.is_(True))
            .order_by(Criterion.position)
        )
    )
    payload_items = []
    for item in items:
        current = next((d for d in item.decisions if d.is_current), None)
        if current is None:
            continue
        payload_items.append(
            {
                "work_item_id": item.id,
                "submitted_at": item.submitted_at.isoformat()
                if item.submitted_at
                else None,
                "publication": db.get(Publication, item.publication_id),
                "decision": current,
            }
        )
    return {
        "stage_completed": stage_completed(project, stage),
        "criteria": criteria,
        "items": payload_items,
    }
