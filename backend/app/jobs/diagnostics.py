from __future__ import annotations

from typing import Any

from sqlalchemy.orm import Session

from app.fulltext.models import PublicationDocument
from app.imports.models import ImportBatch
from app.jobs.models import BackgroundJob
from app.llm.models import LlmExtractionRun, LlmTaskType
from app.llm.service import LLM_JOB, TEXT_JOB
from app.notifications.models import EmailNotification
from app.notifications.service import CHECK_LLM_STAGE_EMAIL_JOB, SEND_EMAIL_JOB
from app.projects.models import Project
from app.publications.models import Publication

JOB_LABELS = {
    "parse_import": "Parse publication import",
    "enrich_publication": "Enrich publication metadata",
    "detect_duplicates": "Detect duplicate publications",
    "generate_export": "Generate project export",
    TEXT_JOB: "Extract text from a full-text document",
    LLM_JOB: "Run LLM processing",
    SEND_EMAIL_JOB: "Send email notification",
    CHECK_LLM_STAGE_EMAIL_JOB: "Check LLM bulk-completion notifications",
}

JOB_STAGES = {
    "parse_import": "Publication import",
    "enrich_publication": "Publication metadata",
    "detect_duplicates": "Duplicate review",
    "generate_export": "Reporting and export",
    TEXT_JOB: "Full-text preparation",
    LLM_JOB: "LLM processing",
    SEND_EMAIL_JOB: "Notifications",
    CHECK_LLM_STAGE_EMAIL_JOB: "Notifications",
}

TASK_STAGES = {
    LlmTaskType.TITLE_ABSTRACT_SCREENING: "Title/abstract screening",
    LlmTaskType.FULL_TEXT_SCREENING: "Full-text screening",
    LlmTaskType.DATA_EXTRACTION: "Data extraction",
    LlmTaskType.EXTRACTION_VALIDATION: "Extraction validation",
}

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
    elif job.job_type == "enrich_publication":
        publication_id = str(job.payload.get("publication_id", "")) or None
    elif job.job_type == "detect_duplicates":
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
    elif job.job_type == LLM_JOB:
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
