"""Canonical background-job registry.

Every background job type is defined exactly once here: its handler, which
worker pool it belongs on, and the static label/stage used for diagnostics.
Worker dispatch (jobs/worker.py) and failure diagnostics (jobs/diagnostics.py)
both derive their behavior from this module instead of maintaining their own
independent job-type collections -- that drift (most notably STAGE_ANALYSIS_JOB
calling Ollama but never being routed to the dedicated --llm worker pool) is
exactly what this registry exists to prevent.

To add a new job type: add one JOB_DEFINITIONS entry. Handler dispatch,
LLM/general worker-pool filtering, and diagnostic labels/stages all update
automatically.
"""

from __future__ import annotations

import enum
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from sqlalchemy.orm import Session

from app.analysis.jobs import STAGE_ANALYSIS_JOB, generate_stage_analysis_job
from app.analysis.rq_jobs import RQ_SYNTHESIS_JOB, generate_rq_synthesis_job
from app.bookmarks.exports import BOOKMARK_EXPORT_JOB, export_bookmarks_job
from app.deduplication.jobs import (
    assess_duplicate_candidates_job,
    detect_duplicates_job,
    release_duplicate_check_after_failure,
)
from app.imports.service import mark_import_permanently_failed, process_import_job
from app.jobs.models import BackgroundJob
from app.llm.models import LlmTaskType
from app.llm.service import LLM_JOB_TYPE_BY_TASK, TEXT_JOB
from app.llm.task_execution import run_llm_task_job
from app.llm.text_extraction import extract_document_text_job
from app.notifications.service import (
    CHECK_LLM_STAGE_EMAIL_JOB,
    SEND_EMAIL_JOB,
    check_llm_stage_email_job,
    send_email_job,
)
from app.projects.cloning import CLONE_PROJECT_JOB, clone_project_job
from app.publications.jobs import enrich_publication_job, resolve_merge_conflicts_job
from app.reporting.jobs import generate_export_job

Handler = Callable[[Session, BackgroundJob], dict[str, Any]]
# Called once, by the worker, when a job reaches a terminal FAILED state --
# either because it raised on its last allowed attempt or because it was
# abandoned by a worker that died with no retries left. Lets the owning domain
# keep its own state in step with job state (an ImportBatch must not sit in
# PROCESSING after its parse job has permanently given up). Runs inside a
# SAVEPOINT in the worker's failure transaction, so it may write but must not
# commit or roll back.
PermanentFailureHook = Callable[[Session, BackgroundJob, str], None]


class WorkerPool(enum.StrEnum):
    """Which worker process is allowed to claim a job type.

    LLM jobs run on a separate, resource-limited worker (``--llm``) with its
    own Ollama concurrency limit; everything else runs on the general
    worker's unbounded thread pool. A job that calls Ollama but is
    classified GENERAL would bypass that concurrency limit entirely.
    """

    GENERAL = "general"
    LLM = "llm"


@dataclass(frozen=True)
class JobDefinition:
    handler: Handler
    worker_pool: WorkerPool
    label: str
    stage: str
    on_permanent_failure: PermanentFailureHook | None = None


# Human-readable stage per LLM task type -- shared between this registry
# (static per-job-type stage) and jobs/diagnostics.py (which additionally
# uses it to relabel a job dynamically once it knows the actual
# LlmExtractionRun's task_type, which can differ from what the job_type alone
# implies only in the sense of giving richer diagnostic context).
TASK_STAGES: dict[LlmTaskType, str] = {
    LlmTaskType.TITLE_ABSTRACT_SCREENING: "Title/abstract screening",
    LlmTaskType.FULL_TEXT_SCREENING: "Full-text screening",
    LlmTaskType.DATA_EXTRACTION: "Data extraction",
    LlmTaskType.EXTRACTION_VALIDATION: "Extraction validation",
}


def _llm_task_definitions() -> dict[str, JobDefinition]:
    return {
        job_type: JobDefinition(
            handler=run_llm_task_job,
            worker_pool=WorkerPool.LLM,
            label=f"Run LLM {TASK_STAGES[task_type].lower()}",
            stage=TASK_STAGES[task_type],
        )
        for task_type, job_type in LLM_JOB_TYPE_BY_TASK.items()
    }


JOB_DEFINITIONS: dict[str, JobDefinition] = {
    "parse_import": JobDefinition(
        handler=process_import_job,
        worker_pool=WorkerPool.GENERAL,
        label="Parse publication import",
        stage="Publication import",
        on_permanent_failure=mark_import_permanently_failed,
    ),
    "enrich_publication": JobDefinition(
        handler=enrich_publication_job,
        worker_pool=WorkerPool.GENERAL,
        label="Enrich publication metadata",
        stage="Publication metadata",
    ),
    "resolve_merge_conflicts": JobDefinition(
        handler=resolve_merge_conflicts_job,
        worker_pool=WorkerPool.GENERAL,
        label="Resolve merge metadata conflicts via provider",
        stage="Duplicate review",
    ),
    "detect_duplicates": JobDefinition(
        handler=detect_duplicates_job,
        worker_pool=WorkerPool.GENERAL,
        label="Detect duplicate publications",
        stage="Duplicate review",
        on_permanent_failure=release_duplicate_check_after_failure,
    ),
    "assess_duplicate_candidates": JobDefinition(
        handler=assess_duplicate_candidates_job,
        worker_pool=WorkerPool.GENERAL,
        label="Assess duplicate candidates via providers",
        stage="Duplicate review",
    ),
    "generate_export": JobDefinition(
        handler=generate_export_job,
        worker_pool=WorkerPool.GENERAL,
        label="Generate project export",
        stage="Reporting and export",
    ),
    BOOKMARK_EXPORT_JOB: JobDefinition(
        handler=export_bookmarks_job,
        worker_pool=WorkerPool.GENERAL,
        label="Export bookmarked publications",
        stage="Bookmarks",
    ),
    TEXT_JOB: JobDefinition(
        handler=extract_document_text_job,
        worker_pool=WorkerPool.GENERAL,
        label="Extract text from a full-text document",
        stage="Full-text preparation",
    ),
    # Calls Ollama via generate_narrative() -- must run on the LLM worker
    # pool like every other Ollama-calling job type, so it respects the
    # same bounded concurrency limit instead of running unbounded on the
    # general worker.
    STAGE_ANALYSIS_JOB: JobDefinition(
        handler=generate_stage_analysis_job,
        worker_pool=WorkerPool.LLM,
        label="Generate stage analysis narrative",
        stage="Stage narrative",
    ),
    RQ_SYNTHESIS_JOB: JobDefinition(
        handler=generate_rq_synthesis_job,
        worker_pool=WorkerPool.LLM,
        label="Run LLM research-question synthesis",
        stage="Research question synthesis",
    ),
    SEND_EMAIL_JOB: JobDefinition(
        handler=send_email_job,
        worker_pool=WorkerPool.GENERAL,
        label="Send email notification",
        stage="Notifications",
    ),
    CHECK_LLM_STAGE_EMAIL_JOB: JobDefinition(
        handler=check_llm_stage_email_job,
        worker_pool=WorkerPool.GENERAL,
        label="Check LLM bulk-completion notifications",
        stage="Notifications",
    ),
    CLONE_PROJECT_JOB: JobDefinition(
        handler=clone_project_job,
        worker_pool=WorkerPool.GENERAL,
        label="Copy project",
        stage="Project copy",
    ),
    **_llm_task_definitions(),
}

# Derived views -- the only things callers should actually need.
HANDLERS: dict[str, Handler] = {
    job_type: definition.handler for job_type, definition in JOB_DEFINITIONS.items()
}
LLM_JOB_TYPES: set[str] = {
    job_type
    for job_type, definition in JOB_DEFINITIONS.items()
    if definition.worker_pool == WorkerPool.LLM
}
JOB_LABELS: dict[str, str] = {
    job_type: definition.label for job_type, definition in JOB_DEFINITIONS.items()
}
JOB_STAGES: dict[str, str] = {
    job_type: definition.stage for job_type, definition in JOB_DEFINITIONS.items()
}
PERMANENT_FAILURE_HOOKS: dict[str, PermanentFailureHook] = {
    job_type: definition.on_permanent_failure
    for job_type, definition in JOB_DEFINITIONS.items()
    if definition.on_permanent_failure is not None
}
