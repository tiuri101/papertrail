from pathlib import Path
from fastapi import APIRouter, Depends, status
from fastapi.responses import FileResponse
from sqlalchemy import select
from sqlalchemy.orm import Session
from pydantic import BaseModel
from app.accounts.dependencies import get_current_user, require_admin_csrf
from app.accounts.models import User
from app.api.errors import NotFoundError
from app.audit.service import record_audit
from app.db.session import get_db
from app.jobs.service import enqueue_job
from app.projects.service import require_project_access
from app.reporting.models import ExportArtifact
from app.reporting.service import calculate_prisma_counts
router=APIRouter(tags=["reporting"])
class ExportRequest(BaseModel): exportType:str; scope:str="included"
@router.get("/projects/{project_id}/prisma")
def prisma_counts(project_id:str,user:User=Depends(get_current_user),db:Session=Depends(get_db)):
    require_project_access(db,project_id,user); return calculate_prisma_counts(db,project_id)
@router.post("/projects/{project_id}/exports",status_code=status.HTTP_202_ACCEPTED)
def create_export(project_id:str,payload:ExportRequest,admin:User=Depends(require_admin_csrf),db:Session=Depends(get_db)):
    require_project_access(db, project_id, admin)
    job = enqueue_job(db, "generate_export", {"export_type": payload.exportType, "scope": payload.scope}, project_id=project_id, created_by_id=admin.id)
    record_audit(db, action="export.queued", entity_type="background_job", entity_id=job.id, project_id=project_id, actor_id=admin.id, summary=f"Queued {payload.exportType} export")
    db.commit()
    return {"jobId": job.id}
@router.get("/projects/{project_id}/exports")
def list_exports(project_id:str,user:User=Depends(get_current_user),db:Session=Depends(get_db)):
    require_project_access(db,project_id,user); return [{"id":x.id,"type":x.export_type,"filename":x.filename,"createdAt":x.created_at} for x in db.scalars(select(ExportArtifact).where(ExportArtifact.project_id==project_id).order_by(ExportArtifact.created_at.desc()))]
@router.get("/projects/{project_id}/exports/{artifact_id}/download")
def download_export(project_id:str,artifact_id:str,user:User=Depends(get_current_user),db:Session=Depends(get_db)):
    require_project_access(db,project_id,user); artifact=db.get(ExportArtifact,artifact_id)
    if artifact is None or artifact.project_id!=project_id or not Path(artifact.stored_path).is_file(): raise NotFoundError("Export not found")
    return FileResponse(artifact.stored_path,filename=artifact.filename)
