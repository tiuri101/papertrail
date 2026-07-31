import re
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.jobs.models import BackgroundJob
from app.projects.models import Project
from app.reporting.models import ExportArtifact
from app.reporting.service import (
    build_bibtex,
    build_excel,
    build_prisma_svg,
    build_prisma_tables,
    calculate_prisma_counts,
)

_TYPES_WITHOUT_SUFFIX = {"xlsx", "bibtex"}


def _slugify_project_name(name: str) -> str:
    slug = re.sub(r'[\\/:*?"<>|]+', "", name).strip()
    slug = re.sub(r"\s+", "_", slug)
    return slug or "project"


def _export_filename(project_name: str, export_type: str, extension: str) -> str:
    date_str = datetime.now(UTC).strftime("%Y-%m-%d")
    safe_name = _slugify_project_name(project_name)
    if export_type in _TYPES_WITHOUT_SUFFIX:
        return f"{safe_name}_{date_str}.{extension}"
    return f"{safe_name}_{export_type}_{date_str}.{extension}"


def generate_export_job(db: Session, job: BackgroundJob) -> dict:
    existing = db.scalar(select(ExportArtifact).where(ExportArtifact.job_id == job.id))
    if existing is not None:
        return {"artifactId": existing.id, "filename": existing.filename}
    project = db.get(Project, job.project_id)
    if project is None:
        raise ValueError("Project not found")
    export_type = job.payload["export_type"]
    scope = job.payload.get("scope", "included")
    status_filter = job.payload.get("status_filter")
    if export_type == "xlsx":
        data = build_excel(db, project.id)
        extension = "xlsx"
    elif export_type == "prisma_tables":
        data = build_prisma_tables(db, project.id)
        extension = "xlsx"
    elif export_type == "bibtex":
        data = build_bibtex(db, project.id, scope, status_filter).encode()
        extension = "bib"
    elif export_type == "prisma_svg":
        data = build_prisma_svg(
            project.name, calculate_prisma_counts(db, project.id)
        ).encode()
        extension = "svg"
    else:
        raise ValueError("Unsupported export type")
    directory = get_settings().export_dir / project.id
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"{job.id}.{extension}"
    path.write_bytes(data)
    filename = _export_filename(project.name, export_type, extension)
    artifact = ExportArtifact(
        project_id=project.id,
        job_id=job.id,
        export_type=export_type,
        filename=filename,
        stored_path=str(path),
        created_by_id=job.created_by_id,
    )
    db.add(artifact)
    db.flush()
    return {"artifactId": artifact.id, "filename": filename}
