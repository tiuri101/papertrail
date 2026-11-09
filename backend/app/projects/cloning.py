"""Deep-copying a project: every row it owns, every file those rows name.

A clone is a new, fully independent project in exactly the state the source
was in -- publications, imports, duplicate review, PDFs and their extracted
text, screening decisions, final decisions, extraction and quality work, LLM
runs and suggestions, analyses, bookmarks and the audit trail.  Reviewers who
had work in flight resume it in the clone just as they would in the source.

The copy is driven by :data:`_CLONE_PLAN`: one entry per project-owned table,
in an order that inserts every row after the rows it references.  Each row is
copied column by column with three generic rewrites, so a column added to a
copied table is cloned correctly without touching this module:

* a primary key gets a new id,
* a foreign key into a copied table is remapped to the clone's row (and one
  that cannot be remapped is an error, never a silent link back into the
  source project),
* any other string -- a plain ``String(36)`` reference such as
  ``ReviewForm.active_version_id``, or one nested anywhere in a JSON document,
  dict keys included -- that equals a copied row's id is remapped too.  Ids
  are UUIDs, so an accidental match with unrelated text cannot happen.

A *table* added to the schema has to be classified explicitly, either in the
plan or in :data:`NOT_CLONED_PROJECT_TABLES` / :data:`GLOBAL_TABLES`;
``tests/test_project_cloning.py`` fails until it is.

New ids are derived deterministically (UUIDv5 under the target project's id),
so a retried clone job writes exactly the same ids and file paths as the
attempt before it, and can clean up whatever that attempt left on disk.

Runs as the ``clone_project`` background job: copying a project's PDFs is
unbounded work that must not happen on a request thread.  Files are copied
before the worker commits, so a job cancelled while it runs (the worker then
rolls back) leaves its copied files behind as orphans under the target
project's id -- the same "orphan, never a dangling row" trade-off
``app.projects.file_cleanup`` makes.
"""

from __future__ import annotations

import logging
import shutil
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from uuid import UUID, uuid5

from sqlalchemy import (
    ColumnElement,
    Connection,
    Select,
    Table,
    bindparam,
    insert,
    select,
    update,
)
from sqlalchemy.orm import Session

from app.accounts.models import User
from app.analysis.models import ResearchQuestionAnalysisRun, StageAnalysis
from app.audit.models import AuditEvent
from app.audit.service import record_audit
from app.bookmarks.models import PublicationBookmark
from app.conflicts.models import FinalDecision
from app.core.config import Settings, get_settings
from app.core.time import utcnow
from app.db.base import Base
from app.deduplication.models import (
    DuplicateCandidate,
    PublicationMerge,
    PublicationUrlCheck,
)
from app.extraction.models import (
    ExtractionConfig,
    ExtractionResponse,
    ExtractionWorkItem,
    FinalExtraction,
)
from app.forms.models import FormField, FormVersion, ReviewForm
from app.fulltext.models import FullTextRetrieval, PublicationDocument
from app.fulltext.storage import storage_path
from app.imports.models import ImportBatch, ImportedRecord, ImportPdfItem, SearchSource
from app.jobs.models import BackgroundJob
from app.llm.models import (
    DocumentPageText,
    DocumentTextExtraction,
    ExtractionSuggestionReview,
    LlmCriterionSuggestion,
    LlmExtractionRun,
    LlmFieldSuggestion,
    LlmSchemaField,
    LlmSchemaVersion,
    LlmValidationResult,
    ProjectLlmSettings,
)
from app.notifications.service import queue_project_copy_completed_email
from app.pdf_acquisition.models import PdfRetrievalBatch, PdfRetrievalJob
from app.projects.file_cleanup import ProjectFileCleanup
from app.projects.job_safety import (
    LifecycleOperation,
    require_no_unfinished_jobs,
)
from app.projects.models import (
    Criterion,
    Project,
    ProjectMembership,
    ResearchQuestion,
    ScreeningConfig,
)
from app.publications.models import MetadataConflict, Publication, PublicationSource
from app.quality.models import QualityConfig, QualityResponse, QualityWorkItem
from app.screening.models import ScreeningDecision, ScreeningWorkItem

logger = logging.getLogger(__name__)

CLONE_PROJECT_JOB = "clone_project"

_BATCH_SIZE = 500

# A row-selection predicate for the source project's rows of one table.
Scope = Callable[[str], ColumnElement[bool]]


def _by_project(model: Any) -> Scope:
    return lambda project_id: model.project_id == project_id


def _via(column: Any, parent: Any, parent_scope: Scope) -> Scope:
    """Rows whose ``column`` points at one of ``parent``'s in-scope rows."""
    return lambda project_id: column.in_(select(parent.id).where(parent_scope(project_id)))


@dataclass(frozen=True)
class _Step:
    model: Any
    scope: Scope
    # Self-referencing foreign keys. Inserted as NULL and filled in once the
    # whole table is copied, since the referenced row may come later in the
    # same table and PostgreSQL checks foreign keys immediately.
    deferred: tuple[str, ...] = ()

    @property
    def table(self) -> Table:
        return self.model.__table__  # type: ignore[no-any-return]


_publications = _by_project(Publication)
_forms = _by_project(ReviewForm)
_form_versions = _via(FormVersion.form_id, ReviewForm, _forms)
_schema_versions = _by_project(LlmSchemaVersion)
_import_batches = _by_project(ImportBatch)
_documents = _by_project(PublicationDocument)
_text_extractions = _via(DocumentTextExtraction.document_id, PublicationDocument, _documents)
_screening_items = _by_project(ScreeningWorkItem)
_extraction_items = _by_project(ExtractionWorkItem)
_quality_items = _by_project(QualityWorkItem)
_llm_runs = _by_project(LlmExtractionRun)

_CLONE_PLAN: tuple[_Step, ...] = (
    _Step(Project, lambda project_id: Project.id == project_id),
    # Configuration
    _Step(ProjectMembership, _by_project(ProjectMembership)),
    _Step(ResearchQuestion, _by_project(ResearchQuestion)),
    _Step(Criterion, _by_project(Criterion)),
    _Step(ScreeningConfig, _by_project(ScreeningConfig)),
    _Step(ExtractionConfig, _by_project(ExtractionConfig)),
    _Step(QualityConfig, _by_project(QualityConfig)),
    _Step(ProjectLlmSettings, _by_project(ProjectLlmSettings)),
    _Step(StageAnalysis, _by_project(StageAnalysis)),
    _Step(ReviewForm, _forms),
    _Step(FormVersion, _form_versions),
    _Step(FormField, _via(FormField.form_version_id, FormVersion, _form_versions)),
    _Step(LlmSchemaVersion, _schema_versions),
    _Step(
        LlmSchemaField,
        _via(LlmSchemaField.schema_version_id, LlmSchemaVersion, _schema_versions),
    ),
    # Searches and imports
    _Step(SearchSource, _by_project(SearchSource)),
    _Step(ImportBatch, _import_batches),
    _Step(
        ImportedRecord,
        _via(ImportedRecord.import_batch_id, ImportBatch, _import_batches),
    ),
    # Publications and duplicate review
    _Step(Publication, _publications, deferred=("merged_into_id",)),
    _Step(
        PublicationSource,
        _via(PublicationSource.publication_id, Publication, _publications),
    ),
    _Step(
        MetadataConflict,
        _via(MetadataConflict.publication_id, Publication, _publications),
    ),
    _Step(
        PublicationUrlCheck,
        _via(PublicationUrlCheck.publication_id, Publication, _publications),
    ),
    _Step(DuplicateCandidate, _by_project(DuplicateCandidate)),
    _Step(PublicationMerge, _by_project(PublicationMerge)),
    # Full text
    _Step(PublicationDocument, _documents, deferred=("replaced_by_document_id",)),
    _Step(FullTextRetrieval, _by_project(FullTextRetrieval)),
    _Step(ImportPdfItem, _by_project(ImportPdfItem)),
    _Step(DocumentTextExtraction, _text_extractions),
    _Step(
        DocumentPageText,
        _via(
            DocumentPageText.text_extraction_id,
            DocumentTextExtraction,
            _text_extractions,
        ),
    ),
    # Screening
    _Step(ScreeningWorkItem, _screening_items),
    _Step(
        ScreeningDecision,
        _via(ScreeningDecision.work_item_id, ScreeningWorkItem, _screening_items),
    ),
    _Step(FinalDecision, _by_project(FinalDecision)),
    # Extraction and quality
    _Step(ExtractionWorkItem, _extraction_items),
    _Step(
        ExtractionResponse,
        _via(ExtractionResponse.work_item_id, ExtractionWorkItem, _extraction_items),
    ),
    _Step(FinalExtraction, _by_project(FinalExtraction)),
    _Step(QualityWorkItem, _quality_items),
    _Step(
        QualityResponse,
        _via(QualityResponse.work_item_id, QualityWorkItem, _quality_items),
    ),
    # LLM assistance
    _Step(LlmExtractionRun, _llm_runs),
    _Step(
        LlmFieldSuggestion,
        _via(LlmFieldSuggestion.run_id, LlmExtractionRun, _llm_runs),
    ),
    _Step(
        LlmCriterionSuggestion,
        _via(LlmCriterionSuggestion.run_id, LlmExtractionRun, _llm_runs),
    ),
    _Step(
        LlmValidationResult,
        _via(LlmValidationResult.run_id, LlmExtractionRun, _llm_runs),
    ),
    _Step(ExtractionSuggestionReview, _by_project(ExtractionSuggestionReview)),
    _Step(ResearchQuestionAnalysisRun, _by_project(ResearchQuestionAnalysisRun)),
    # Browser-assisted retrieval history
    _Step(PdfRetrievalBatch, _by_project(PdfRetrievalBatch)),
    _Step(PdfRetrievalJob, _by_project(PdfRetrievalJob)),
    # Per-user and history
    _Step(PublicationBookmark, _by_project(PublicationBookmark)),
    _Step(AuditEvent, _by_project(AuditEvent)),
)

CLONED_TABLES: frozenset[str] = frozenset(step.table.name for step in _CLONE_PLAN)

#: Tables with project-scoped rows that are deliberately *not* cloned:
#: background jobs belong to the worker run that executed them (a clone
#: references none -- see ``_NULLED_REFERENCES``), queued emails were
#: addressed about the source project, and exports are generated snapshots of
#: the source that the clone can regenerate under its own name.
NOT_CLONED_PROJECT_TABLES: frozenset[str] = frozenset(
    {"background_jobs", "email_notifications", "export_artifacts"}
)

#: Installation-wide tables a clone shares with its source by reference.
GLOBAL_TABLES: frozenset[str] = frozenset(
    {
        "users",
        "user_sessions",
        "login_throttles",
        "password_reset_tokens",
        "instance_settings",
        "llm_installation_settings",
        "browser_agents",
        "browser_agent_pairings",
    }
)

# Foreign keys into tables that are not cloned and must not keep pointing at
# the source's rows.
_NULLED_REFERENCES = frozenset({"background_jobs"})


class CloneError(RuntimeError):
    """The source project could not be copied consistently."""


@dataclass
class _CloneState:
    source_project_id: str
    target_project_id: str
    settings: Settings
    namespace: UUID = field(init=False)
    id_map: dict[str, str] = field(default_factory=dict)
    # (source path, destination path) for every file the clone needs.
    files: list[tuple[Path, Path]] = field(default_factory=list)
    new_import_batch_ids: list[str] = field(default_factory=list)

    def __post_init__(self) -> None:
        self.namespace = UUID(self.target_project_id)

    def new_id(self, old_id: str) -> str:
        return str(uuid5(self.namespace, old_id))


# --------------------------------------------------------------------------
# Enqueueing


def enqueue_project_clone(
    db: Session, project: Project, *, name: str, actor: User
) -> BackgroundJob:
    """Queue a deep copy of ``project`` named ``name``, owned by ``actor``.

    Refused while the project has unfinished background jobs: their pending
    LLM runs, imports or text extractions would be copied mid-flight into a
    project that has no job left to finish them.
    """
    from uuid import uuid4

    from app.jobs.service import enqueue_job

    require_no_unfinished_jobs(db, project.id, operation=LifecycleOperation.CLONE)
    job = enqueue_job(
        db,
        CLONE_PROJECT_JOB,
        {"target_project_id": str(uuid4()), "name": name.strip()},
        project_id=project.id,
        created_by_id=actor.id,
    )
    record_audit(
        db,
        action="project.clone_requested",
        entity_type="project",
        entity_id=project.id,
        project_id=project.id,
        actor_id=actor.id,
        summary=f"Requested a copy of project {project.name} named {name.strip()}",
        metadata={"jobId": job.id, "targetProjectId": job.payload["target_project_id"]},
    )
    return job


# --------------------------------------------------------------------------
# The job


def clone_project_job(db: Session, job: BackgroundJob) -> dict[str, Any]:
    source_project_id = job.project_id
    target_project_id = str(job.payload["target_project_id"])
    name = str(job.payload["name"])
    if source_project_id is None:
        raise CloneError("Clone job has no source project")
    if db.get(Project, target_project_id) is not None:
        # Already committed by an earlier attempt of this same job.
        return {"projectId": target_project_id, "projectName": name}
    owner = db.get(User, job.created_by_id) if job.created_by_id else None
    if owner is None:
        raise CloneError("The user who requested this copy no longer exists")

    state = _CloneState(
        source_project_id=source_project_id,
        target_project_id=target_project_id,
        settings=get_settings(),
    )
    try:
        with _snapshot(db) as source:
            source_project = source.execute(
                select(Project.name).where(Project.id == source_project_id)
            ).scalar_one_or_none()
            if source_project is None:
                raise CloneError("Source project not found")
            require_no_unfinished_jobs(
                source,
                source_project_id,
                operation=LifecycleOperation.CLONE,
                exclude_job_id=job.id,
            )
            _assign_ids(source, state)
            # Files a previous, rolled-back attempt of this job may have
            # copied. Ids are deterministic, so these are exactly its paths.
            _cleanup_for(state).remove(state.settings)
            for step in _CLONE_PLAN:
                _copy_table(source, db, step, state, name=name, owner_id=owner.id)
            _rebase_fingerprints(source, db, state)
        _ensure_owner(db, state, owner)
        missing = _copy_files(state)
        record_audit(
            db,
            action="project.cloned",
            entity_type="project",
            entity_id=source_project_id,
            project_id=source_project_id,
            actor_id=owner.id,
            summary=f"Copied project {source_project} into {name}",
            metadata={"targetProjectId": target_project_id},
        )
        record_audit(
            db,
            action="project.created_from_clone",
            entity_type="project",
            entity_id=target_project_id,
            project_id=target_project_id,
            actor_id=owner.id,
            summary=f"Created project {name} as a copy of {source_project}",
            metadata={
                "sourceProjectId": source_project_id,
                "missingFiles": len(missing),
            },
        )
        # Queued in the clone's own transaction: the email goes out exactly
        # when the copy commits, and never for an attempt that rolls back.
        queue_project_copy_completed_email(
            db,
            owner,
            job_id=job.id,
            source_project_name=source_project,
            target_project_id=target_project_id,
            target_project_name=name,
            missing_files=len(missing),
        )
        db.flush()
    except BaseException:
        # Nothing of this attempt is committed; take its files with it.
        _cleanup_for(state).remove(state.settings)
        raise
    return {
        "projectId": target_project_id,
        "projectName": name,
        "missingFiles": len(missing),
    }


@contextmanager
def _snapshot(db: Session) -> Iterator[Connection]:
    """A connection that sees the source project at one point in time.

    On PostgreSQL that is a separate REPEATABLE READ, READ ONLY transaction:
    reviewers keep working on the source while the copy runs, and under the
    default READ COMMITTED each table would be read at a different moment --
    a decision committed between copying work items and copying decisions
    would arrive without its work item.  The writes stay on the worker's own
    session, so they commit together with the job's completion.

    Elsewhere (the SQLite test engine) reads share the session's connection.
    """
    bind = db.get_bind()
    if bind.dialect.name != "postgresql":
        yield db.connection()
        return
    with bind.engine.connect() as connection:
        connection = connection.execution_options(isolation_level="REPEATABLE READ")
        with connection.begin():
            connection.exec_driver_sql("SET TRANSACTION READ ONLY")
            yield connection


def _assign_ids(source: Connection, state: _CloneState) -> None:
    state.id_map[state.source_project_id] = state.target_project_id
    for step in _CLONE_PLAN[1:]:
        id_column = step.table.c.id
        for old_id in source.execute(
            select(id_column).where(step.scope(state.source_project_id))
        ).scalars():
            state.id_map[old_id] = state.new_id(old_id)
    state.new_import_batch_ids = [
        state.id_map[old_id]
        for old_id in source.execute(
            select(ImportBatch.id).where(_import_batches(state.source_project_id))
        ).scalars()
    ]


def _cleanup_for(state: _CloneState) -> ProjectFileCleanup:
    return ProjectFileCleanup(
        project_id=state.target_project_id,
        project_trees=True,
        import_batch_ids=tuple(state.new_import_batch_ids),
    )


def _copy_table(
    source: Connection,
    db: Session,
    step: _Step,
    state: _CloneState,
    *,
    name: str,
    owner_id: str,
) -> None:
    table = step.table
    query: Select[Any] = (
        select(table)
        .where(step.scope(state.source_project_id))
        .execution_options(yield_per=_BATCH_SIZE)
    )
    deferred: dict[str, list[dict[str, Any]]] = {column: [] for column in step.deferred}
    for partition in source.execute(query).mappings().partitions():
        rows = []
        for source_row in partition:
            row = _remap_row(table, source_row, state)
            for column in step.deferred:
                if row[column] is not None:
                    deferred[column].append({"_id": row["id"], "_value": row[column]})
                row[column] = None
            _apply_overrides(table.name, row, source_row, state, name, owner_id)
            rows.append(row)
        if rows:
            db.execute(insert(table), rows)
    for column, values in deferred.items():
        if values:
            db.execute(
                update(table)
                .where(table.c.id == bindparam("_id"))
                .values({column: bindparam("_value")}),
                values,
            )
    db.flush()


def _remap_row(table: Table, source_row: Any, state: _CloneState) -> dict[str, Any]:
    row: dict[str, Any] = {}
    for column in table.columns:
        value = source_row[column.key]
        if column.primary_key:
            row[column.key] = state.id_map[value]
            continue
        foreign_tables = {fk.column.table.name for fk in column.foreign_keys}
        if foreign_tables and value is not None:
            (target_table,) = foreign_tables
            if target_table in _NULLED_REFERENCES:
                value = None
            elif target_table in CLONED_TABLES:
                if value not in state.id_map:
                    raise CloneError(
                        f"{table.name}.{column.key} references a "
                        f"{target_table} row outside the project being copied"
                    )
                value = state.id_map[value]
            # Otherwise a shared, installation-wide row (a user, a browser
            # agent): the clone references the same one.
        else:
            value = _remap_value(value, state.id_map)
        row[column.key] = value
    return row


def _remap_value(value: Any, id_map: dict[str, str]) -> Any:
    if isinstance(value, str):
        return id_map.get(value, value)
    if isinstance(value, dict):
        return {
            _remap_value(key, id_map): _remap_value(item, id_map) for key, item in value.items()
        }
    if isinstance(value, list):
        return [_remap_value(item, id_map) for item in value]
    return value


def _apply_overrides(
    table_name: str,
    row: dict[str, Any],
    source_row: Any,
    state: _CloneState,
    name: str,
    owner_id: str,
) -> None:
    """The handful of columns that must differ from a straight copy."""
    if table_name == "projects":
        now = utcnow()
        row["name"] = name
        row["created_at"] = now
        row["updated_at"] = now
    elif table_name == "project_memberships":
        # Exactly one owner per project: whoever made the copy.
        row["is_owner"] = row["user_id"] == owner_id
    elif table_name == "publication_documents":
        row["storage_key"] = (
            f"projects/{state.target_project_id}/publications/"
            f"{row['publication_id']}/{row['id']}.pdf"
        )
        _plan_pdf_copy(state, source_row["storage_key"], row["storage_key"])
    elif table_name == "import_pdf_items" and row["storage_key"]:
        row["storage_key"] = (
            f"staging/imports/{row['import_batch_id']}/"
            f"{state.new_id(source_row['storage_key'])}.pdf"
        )
        _plan_pdf_copy(state, source_row["storage_key"], row["storage_key"])
    elif table_name == "import_batches" and row["stored_path"]:
        # Never keep the source's path: deleting the clone's searches would
        # then delete the source's uploaded file.
        source_path = Path(source_row["stored_path"])
        destination = (
            state.settings.import_dir
            / state.target_project_id
            / f"{state.new_id(source_row['stored_path'])}{source_path.suffix}"
        )
        row["stored_path"] = str(destination)
        root = state.settings.import_dir.resolve()
        if root in source_path.resolve().parents:
            state.files.append((source_path, destination))


def _plan_pdf_copy(state: _CloneState, source_key: str, target_key: str) -> None:
    state.files.append(
        (storage_path(source_key, state.settings), storage_path(target_key, state.settings))
    )


def _rebase_fingerprints(source: Connection, db: Session, state: _CloneState) -> None:
    """Recompute the staleness fingerprints the copy would otherwise break.

    LLM runs, research-question syntheses and stage analyses store a SHA-256
    of their inputs, and those inputs include row ids (criteria, the
    publication, its document and text extraction, the final extraction).
    A hash cannot be remapped like an id, so a straight copy would make every
    copied suggestion look stale in the clone. For each one that is current
    in the source, store the clone's own current fingerprint instead; one
    already stale in the source keeps its old value and stays stale.
    """
    from app.analysis.rq_jobs import compute_rq_fingerprint
    from app.analysis.service import compute_stage_stats, compute_stats_fingerprint
    from app.llm.task_service import current_task_fingerprint

    source_session = db if source is db.connection() else Session(bind=source, autoflush=False)
    target_id = state.target_project_id
    try:
        for run in source_session.scalars(
            select(LlmExtractionRun).where(
                LlmExtractionRun.project_id == state.source_project_id,
                LlmExtractionRun.input_fingerprint.is_not(None),
            )
        ):
            if run.input_fingerprint != current_task_fingerprint(source_session, run):
                continue
            copy = db.get(LlmExtractionRun, state.id_map[run.id])
            assert copy is not None
            copy.input_fingerprint = current_task_fingerprint(db, copy)

        for rq_run in source_session.scalars(
            select(ResearchQuestionAnalysisRun).where(
                ResearchQuestionAnalysisRun.project_id == state.source_project_id
            )
        ):
            question = source_session.get(ResearchQuestion, rq_run.research_question_id)
            if question is None or rq_run.input_fingerprint != compute_rq_fingerprint(
                source_session, state.source_project_id, question
            ):
                continue
            rq_copy = db.get(ResearchQuestionAnalysisRun, state.id_map[rq_run.id])
            question_copy = db.get(ResearchQuestion, state.id_map[question.id])
            assert rq_copy is not None and question_copy is not None
            rq_copy.input_fingerprint = compute_rq_fingerprint(db, target_id, question_copy)

        for analysis in source_session.scalars(
            select(StageAnalysis).where(StageAnalysis.project_id == state.source_project_id)
        ):
            source_stats = compute_stage_stats(
                source_session, state.source_project_id, analysis.stage
            )
            if analysis.stats_fingerprint != compute_stats_fingerprint(source_stats):
                continue
            analysis_copy = db.get(StageAnalysis, state.id_map[analysis.id])
            assert analysis_copy is not None
            analysis_copy.stats_fingerprint = compute_stats_fingerprint(
                compute_stage_stats(db, target_id, analysis.stage)
            )
        db.flush()
    finally:
        if source_session is not db:
            source_session.close()


def _ensure_owner(db: Session, state: _CloneState, owner: User) -> None:
    """An administrator can copy a project they are not a member of."""
    if db.scalar(
        select(ProjectMembership.id).where(
            ProjectMembership.project_id == state.target_project_id,
            ProjectMembership.user_id == owner.id,
        )
    ):
        return
    db.add(
        ProjectMembership(
            project_id=state.target_project_id,
            user_id=owner.id,
            is_owner=True,
            can_title_abstract_screen=True,
            can_full_text_screen=True,
            can_extract=True,
            can_assess_quality=True,
            can_adjudicate=True,
        )
    )
    db.flush()


def _copy_files(state: _CloneState) -> list[str]:
    """Copy every planned file; return the source paths that were missing.

    A file missing from the source is already a broken record there; the
    clone reproduces that rather than refusing to copy the rest. Any other
    I/O failure aborts the clone.
    """
    missing: list[str] = []
    for source, destination in state.files:
        if not source.is_file():
            logger.warning(
                "Project %s: %s is missing; its copy in project %s will be too",
                state.source_project_id,
                source,
                state.target_project_id,
            )
            missing.append(str(source))
            continue
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, destination)
    return missing


def unclassified_tables() -> set[str]:
    """Tables this module has not decided how to clone (should be empty)."""
    known = CLONED_TABLES | NOT_CLONED_PROJECT_TABLES | GLOBAL_TABLES
    return set(Base.metadata.tables) - known
