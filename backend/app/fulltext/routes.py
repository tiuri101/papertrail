from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.accounts.dependencies import require_csrf
from app.accounts.models import UserSession
from app.api.errors import NotFoundError
from app.audit.service import record_audit
from app.db.session import get_db
from app.fulltext.models import FullTextRetrieval, RetrievalStatus
from app.fulltext.schemas import RetrievalResponse, RetrievalUpdate
from app.fulltext.service import set_retrieval_status, transition_if_full_text_complete
from app.projects.service import get_project, require_project_access

router = APIRouter(tags=["full text"])

@router.get("/projects/{project_id}/full-text", response_model=list[RetrievalResponse])
def list_retrievals(project_id: str, session: UserSession = Depends(require_csrf), db: Session = Depends(get_db)):
    require_project_access(db, project_id, session.user)
    return list(db.scalars(select(FullTextRetrieval).where(FullTextRetrieval.project_id == project_id)))

@router.put("/projects/{project_id}/full-text/{retrieval_id}", response_model=RetrievalResponse)
def update_retrieval(project_id: str, retrieval_id: str, payload: RetrievalUpdate, session: UserSession = Depends(require_csrf), db: Session = Depends(get_db)):
    require_project_access(db, project_id, session.user)
    retrieval = db.get(FullTextRetrieval, retrieval_id)
    if retrieval is None or retrieval.project_id != project_id:
        raise NotFoundError("Full-text retrieval record not found")
    set_retrieval_status(db, retrieval, RetrievalStatus(payload.status), note=payload.note, user_id=session.user.id)
    transition_if_full_text_complete(db, get_project(db, project_id))
    record_audit(db, action="fulltext.status_changed", entity_type="full_text_retrieval", entity_id=retrieval.id, project_id=project_id, actor_id=session.user.id, summary=f"Set full-text retrieval status to {retrieval.status.value}")
    db.commit()
    return retrieval
