from pathlib import Path
from sqlalchemy import select
from sqlalchemy.orm import Session
from app.core.config import get_settings
from app.jobs.models import BackgroundJob
from app.reporting.models import ExportArtifact
from app.reporting.service import build_bibtex, build_excel, build_prisma_svg, calculate_prisma_counts
from app.projects.models import Project

def generate_export_job(db:Session,job:BackgroundJob)->dict:
    existing = db.scalar(select(ExportArtifact).where(ExportArtifact.job_id == job.id))
    if existing is not None:
        return {"artifactId": existing.id, "filename": existing.filename}
    project=db.get(Project,job.project_id)
    if project is None: raise ValueError("Project not found")
    export_type=job.payload["export_type"]; scope=job.payload.get("scope","included")
    if export_type=="xlsx": data=build_excel(db,project.id); extension="xlsx"
    elif export_type=="bibtex": data=build_bibtex(db,project.id,scope).encode(); extension="bib"
    elif export_type=="prisma_svg": data=build_prisma_svg(project.name,calculate_prisma_counts(db,project.id)).encode(); extension="svg"
    else: raise ValueError("Unsupported export type")
    directory=get_settings().export_dir/project.id; directory.mkdir(parents=True,exist_ok=True)
    filename=f"papertrail_{project.id}_{export_type}.{extension}"; path=directory/filename; path.write_bytes(data)
    artifact=ExportArtifact(project_id=project.id,job_id=job.id,export_type=export_type,filename=filename,stored_path=str(path),created_by_id=job.created_by_id); db.add(artifact); db.flush(); return {"artifactId":artifact.id,"filename":filename}
