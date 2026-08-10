from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, status
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.accounts.dependencies import get_current_user
from app.accounts.models import User
from app.api.errors import NotFoundError
from app.audit.service import record_audit
from app.db.session import get_db
from app.jobs.service import enqueue_job
from app.projects.dependencies import require_project_member_csrf
from app.projects.service import require_project_access
from app.reporting.models import ExportArtifact
from app.reporting.service import (
    build_final_results,
    build_prisma_svg,
    calculate_prisma_counts,
)

router = APIRouter(tags=["reporting"])


class ExportRequest(BaseModel):
    exportType: str
    scope: str = "included"
    statusFilter: dict[str, Any] | None = None
    publicationIds: list[str] | None = None


@router.get("/projects/{project_id}/prisma")
def prisma_counts(
    project_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, int]:
    require_project_access(db, project_id, user)
    return calculate_prisma_counts(db, project_id)


@router.get("/projects/{project_id}/prisma/svg")
def prisma_svg(
    project_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Response:
    project = require_project_access(db, project_id, user)
    svg = build_prisma_svg(project.name, calculate_prisma_counts(db, project_id))
    return Response(
        content=svg,
        media_type="image/svg+xml",
        headers={"Cache-Control": "no-store"},
    )


@router.get("/projects/{project_id}/final-results")
def final_results(
    project_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    require_project_access(db, project_id, user)
    return build_final_results(db, project_id)


@router.post("/projects/{project_id}/exports", status_code=status.HTTP_202_ACCEPTED)
def create_export(
    project_id: str,
    payload: ExportRequest,
    admin: User = Depends(require_project_member_csrf),
    db: Session = Depends(get_db),
) -> dict[str, str]:
    job = enqueue_job(
        db,
        "generate_export",
        {
            "export_type": payload.exportType,
            "scope": payload.scope,
            "status_filter": payload.statusFilter,
            "publication_ids": payload.publicationIds,
        },
        project_id=project_id,
        created_by_id=admin.id,
    )
    record_audit(
        db,
        action="export.queued",
        entity_type="background_job",
        entity_id=job.id,
        project_id=project_id,
        actor_id=admin.id,
        summary=f"Queued {payload.exportType} export",
    )
    db.commit()
    return {"jobId": job.id}


@router.get("/projects/{project_id}/exports")
def list_exports(
    project_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[dict[str, Any]]:
    require_project_access(db, project_id, user)
    return [
        {
            "id": x.id,
            "type": x.export_type,
            "filename": x.filename,
            "createdAt": x.created_at,
        }
        for x in db.scalars(
            select(ExportArtifact)
            .where(ExportArtifact.project_id == project_id)
            .order_by(ExportArtifact.created_at.desc())
        )
    ]


@router.get("/projects/{project_id}/exports/{artifact_id}/download")
def download_export(
    project_id: str,
    artifact_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> FileResponse:
    require_project_access(db, project_id, user)
    artifact = db.get(ExportArtifact, artifact_id)
    if (
        artifact is None
        or artifact.project_id != project_id
        or not Path(artifact.stored_path).is_file()
    ):
        raise NotFoundError("Export not found")
    return FileResponse(artifact.stored_path, filename=artifact.filename)


@router.delete(
    "/projects/{project_id}/exports/{artifact_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def delete_export(
    project_id: str,
    artifact_id: str,
    admin: User = Depends(require_project_member_csrf),
    db: Session = Depends(get_db),
) -> None:
    require_project_access(db, project_id, admin)
    artifact = db.get(ExportArtifact, artifact_id)
    if artifact is None or artifact.project_id != project_id:
        raise NotFoundError("Export not found")
    filename = artifact.filename
    stored_path = Path(artifact.stored_path)
    db.delete(artifact)
    record_audit(
        db,
        action="export.deleted",
        entity_type="export_artifact",
        entity_id=artifact_id,
        project_id=project_id,
        actor_id=admin.id,
        summary=f"Deleted export {filename}",
    )
    db.commit()
    if stored_path.is_file():
        stored_path.unlink(missing_ok=True)
    return None
