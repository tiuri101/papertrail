from __future__ import annotations

from typing import Any

from sqlalchemy.orm import Session

from app.analysis.jobs import STAGE_ANALYSIS_JOB
from app.analysis.models import ResearchQuestionAnalysisRun
from app.analysis.rq_jobs import RQ_SYNTHESIS_JOB
from app.fulltext.models import PublicationDocument
from app.imports.models import ImportBatch
from app.jobs.models import BackgroundJob
from app.jobs.registry import JOB_LABELS, JOB_STAGES, TASK_STAGES
from app.llm.models import LlmExtractionRun, LlmTaskType
from app.llm.service import LLM_JOB_TYPE_BY_TASK, TEXT_JOB
from app.notifications.models import EmailNotification
from app.notifications.service import CHECK_LLM_STAGE_EMAIL_JOB, SEND_EMAIL_JOB
from app.projects.models import Project
from app.publications.models import Publication

# The job types whose diagnostic context is looked up via an LlmExtractionRun
# keyed by payload["run_id"]. Deliberately narrower than
# app.jobs.registry.LLM_JOB_TYPES (which additionally includes
# RQ_SYNTHESIS_JOB and STAGE_ANALYSIS_JOB for --llm worker-pool routing
# purposes): RQ synthesis jobs are keyed by a ResearchQuestionAnalysisRun and
# payload["rq_run_id"] instead, and STAGE_ANALYSIS_JOB has no run row at all
# -- both get their own branches below rather than being folded into this set.
EXTRACTION_RUN_JOB_TYPES = set(LLM_JOB_TYPE_BY_TASK.values())

STAGE_ORDER = [
    "Publication import",
    "Publication metadata",
    "Duplicate review",
    "Full-text preparation",
    "Title/abstract screening",
    "Full-text screening",
    "Data extraction",
    "Extraction validation",
    "Research question synthesis",
    "Stage narrative",
    "Reporting and export",
    "Notifications",
]

PROJECT_STAGE_LABELS = {
    "draft": "Draft",
    "duplicate_review": "Duplicate review",
    "title_abstract_screening": "Title/abstract screening",
    "full_text_screening": "Full-text screening",
    "extraction_quality": "Extraction and quality assessment",
    "completed": "Completed",
}


def _humanize(value: str) -> str:
    return value.replace("_", " ").strip().capitalize()


def _as_text(value: Any) -> str | None:
    return None if value is None or value == "" else str(value)


def build_job_diagnostics(db: Session, job: BackgroundJob) -> dict[str, Any]:
    """Resolve safe, human-readable context for a background job failure."""
    label = JOB_LABELS.get(job.job_type, _humanize(job.job_type))
    affected_stage = JOB_STAGES.get(job.job_type, "Background processing")
    context: dict[str, str | int | bool | None] = {}
    publication_id: str | None = None

    project = db.get(Project, job.project_id) if job.project_id else None
    project_stage = None
    if project is not None:
        stage_value = str(project.stage)
        project_stage = PROJECT_STAGE_LABELS.get(stage_value, _humanize(stage_value))

    if job.job_type == "parse_import":
        batch_id = str(job.payload.get("import_batch_id", ""))
        batch = db.get(ImportBatch, batch_id) if batch_id else None
        context["Import batch ID"] = batch_id or None
        if batch is not None:
            context["Source file"] = batch.original_filename
            context["File type"] = batch.file_type
    elif job.job_type in ("enrich_publication", "resolve_merge_conflicts"):
        publication_id = str(job.payload.get("publication_id", "")) or None
    elif job.job_type in ("detect_duplicates", "assess_duplicate_candidates"):
        context["Detection project ID"] = (
            str(job.payload.get("project_id", job.project_id or "")) or None
        )
    elif job.job_type == "generate_export":
        context["Export format"] = _as_text(job.payload.get("export_type"))
        context["Export scope"] = _as_text(job.payload.get("scope"))
        context["Status filter"] = _as_text(job.payload.get("status_filter"))
    elif job.job_type == TEXT_JOB:
        document_id = str(job.payload.get("document_id", ""))
        document = db.get(PublicationDocument, document_id) if document_id else None
        context["Document ID"] = document_id or None
        context["Text extraction ID"] = (
            str(job.payload.get("text_extraction_id", "")) or None
        )
        if document is not None:
            publication_id = document.publication_id
            context["Document"] = document.original_filename
    elif job.job_type in EXTRACTION_RUN_JOB_TYPES:
        run_id = str(job.payload.get("run_id", ""))
        run = db.get(LlmExtractionRun, run_id) if run_id else None
        context["LLM run ID"] = run_id or None
        if run is not None:
            task_type = LlmTaskType(run.task_type)
            affected_stage = TASK_STAGES[task_type]
            publication_id = run.publication_id
            context["LLM task"] = affected_stage
            context["Model"] = run.model
            context["Document ID"] = run.document_id
            label = f"Run LLM {affected_stage.lower()}"
    elif job.job_type == RQ_SYNTHESIS_JOB:
        rq_run_id = str(job.payload.get("rq_run_id", ""))
        rq_run = db.get(ResearchQuestionAnalysisRun, rq_run_id) if rq_run_id else None
        context["RQ synthesis run ID"] = rq_run_id or None
        if rq_run is not None:
            context["Research question"] = rq_run.research_question_text
            context["Model"] = rq_run.model
    elif job.job_type == STAGE_ANALYSIS_JOB:
        payload_stage = _as_text(job.payload.get("stage"))
        context["Stage"] = (
            PROJECT_STAGE_LABELS.get(payload_stage, _humanize(payload_stage))
            if payload_stage
            else None
        )
    elif job.job_type == CHECK_LLM_STAGE_EMAIL_JOB:
        context["LLM bulk ID"] = _as_text(job.payload.get("bulk_id"))
    elif job.job_type == SEND_EMAIL_JOB:
        notification_id = str(job.payload.get("notification_id", ""))
        notification = (
            db.get(EmailNotification, notification_id) if notification_id else None
        )
        context["Notification ID"] = notification_id or None
        if notification is not None:
            context["Notification template"] = notification.template
            context["Email subject"] = notification.subject
            stage_label = notification.context.get("stage_label")
            if isinstance(stage_label, str) and stage_label:
                affected_stage = stage_label

    if publication_id:
        publication = db.get(Publication, publication_id)
        context["Publication ID"] = publication_id
        context["Publication"] = publication.title if publication is not None else None

    return {
        "job_label": label,
        "affected_stage": affected_stage,
        "project_name": project.name if project is not None else None,
        "project_stage": project_stage,
        "context": {key: value for key, value in context.items() if value is not None},
    }
