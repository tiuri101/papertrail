from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.accounts.service import create_user
from app.audit.models import AuditEvent
from app.conflicts.models import FinalDecision
from app.core.config import get_settings
from app.core.time import utcnow
from app.deduplication.models import DuplicateCandidate, PublicationMerge
from app.extraction.models import ExtractionResponse, ExtractionWorkItem
from app.forms.models import FieldType, FormField, FormKind, FormVersion, ReviewForm
from app.fulltext.models import DocumentSource, PublicationDocument
from app.fulltext.storage import storage_path
from app.imports.models import ImportBatch, ImportedRecord, ImportStatus, SearchSource
from app.jobs.models import BackgroundJob, JobStatus
from app.jobs.worker import execute_next_job
from app.llm.models import (
    LlmExtractionRun,
    LlmFieldSuggestion,
    LlmSchemaField,
    LlmSchemaVersion,
    LlmTaskType,
    ProcessingStatus,
    ProjectLlmSettings,
    SchemaStatus,
    SuggestionStatus,
)
from app.projects import cloning
from app.projects.cloning import CLONED_TABLES, unclassified_tables
from app.projects.models import (
    Criterion,
    CriterionKind,
    Project,
    ProjectMembership,
    ProjectStage,
    ReviewType,
    ScreeningStage,
)
from app.publications.models import Publication, PublicationSource
from app.screening.models import (
    ScreeningDecision,
    ScreeningOutcome,
    ScreeningWorkItem,
    WorkItemStatus,
)

PDF_BYTES = b"%PDF-1.4\n% clone test\n%%EOF\n"


def login(client, username: str, password: str) -> str:
    response = client.post("/api/v1/auth/login", json={"username": username, "password": password})
    assert response.status_code == 200
    return response.json()["csrfToken"]


@pytest.fixture()
def isolated_storage(tmp_path, monkeypatch):
    settings = get_settings()
    monkeypatch.setattr(settings, "pdf_storage_path", tmp_path / "pdfs")
    monkeypatch.setattr(settings, "import_dir", tmp_path / "imports")
    monkeypatch.setattr(settings, "export_dir", tmp_path / "exports")
    for path in (tmp_path / "pdfs", tmp_path / "imports", tmp_path / "exports"):
        path.mkdir()
    return settings


def _write_pdf(key: str) -> None:
    path = storage_path(key)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(PDF_BYTES)


def build_populated_project(db: Session, settings) -> dict[str, Any]:
    """A project with rows in most stages, cross-references, and files."""
    owner = create_user(db, "owner", "Owner", "owner-password")
    reviewer = create_user(db, "reviewer", "Reviewer", "reviewer-password")
    project = Project(
        name="Source Review",
        review_type=ReviewType.SYSTEMATIC_REVIEW,
        random_seed="seed",
        stage=ProjectStage.FULL_TEXT,
        configuration_ready=True,
    )
    db.add(project)
    db.flush()
    db.add_all(
        [
            ProjectMembership(project_id=project.id, user_id=owner.id, is_owner=True),
            ProjectMembership(
                project_id=project.id,
                user_id=reviewer.id,
                can_title_abstract_screen=True,
            ),
        ]
    )
    criterion = Criterion(project_id=project.id, kind=CriterionKind.INCLUSION, text="Adults")
    db.add(criterion)

    form = ReviewForm(project_id=project.id, name="Extraction", kind=FormKind.EXTRACTION)
    db.add(form)
    db.flush()
    version = FormVersion(form_id=form.id, version_number=1)
    db.add(version)
    db.flush()
    form.active_version_id = version.id
    form_field = FormField(
        form_version_id=version.id,
        label="Sample size",
        field_type=FieldType.NUMBER,
        position=0,
    )
    db.add(form_field)

    source = SearchSource(
        project_id=project.id,
        source_name="Scopus",
        query="vr",
        search_date=utcnow().date(),
        created_by_id=owner.id,
    )
    db.add(source)
    db.flush()
    import_file = settings.import_dir / project.id / "upload.ris"
    import_file.parent.mkdir(parents=True)
    import_file.write_text("TY  - JOUR\nER  -\n")
    batch = ImportBatch(
        project_id=project.id,
        search_source_id=source.id,
        original_filename="upload.ris",
        stored_path=str(import_file),
        file_type="ris",
        status=ImportStatus.COMPLETED,
        created_by_id=owner.id,
    )
    db.add(batch)
    db.flush()
    record = ImportedRecord(import_batch_id=batch.id, source_row=0, raw_data={}, parsed_data={})
    db.add(record)

    canonical = Publication(project_id=project.id, title="Canonical")
    merged = Publication(project_id=project.id, title="Merged away", is_active=False)
    db.add_all([canonical, merged])
    db.flush()
    merged.merged_into_id = canonical.id
    db.add(PublicationSource(publication_id=canonical.id, imported_record_id=record.id))
    candidate = DuplicateCandidate(
        project_id=project.id,
        publication_a_id=canonical.id,
        publication_b_id=merged.id,
        confidence=0.99,
        status="merged",
    )
    db.add(candidate)
    db.flush()
    db.add(
        PublicationMerge(
            project_id=project.id,
            canonical_publication_id=canonical.id,
            merged_publication_id=merged.id,
            candidate_id=candidate.id,
            canonical_before={"id": canonical.id},
            merged_before={"merged_into_id": None},
            moved_source_ids=[],
            moved_document_states=[],
        )
    )

    old_key = f"projects/{project.id}/publications/{canonical.id}/old.pdf"
    new_key = f"projects/{project.id}/publications/{canonical.id}/new.pdf"
    _write_pdf(old_key)
    _write_pdf(new_key)
    old_doc = PublicationDocument(
        project_id=project.id,
        publication_id=canonical.id,
        original_filename="old.pdf",
        storage_key=old_key,
        file_size=len(PDF_BYTES),
        sha256="a" * 64,
        is_active=False,
        source=DocumentSource.MANUAL,
    )
    db.add(old_doc)
    db.flush()
    new_doc = PublicationDocument(
        project_id=project.id,
        publication_id=canonical.id,
        original_filename="new.pdf",
        storage_key=new_key,
        file_size=len(PDF_BYTES),
        sha256="b" * 64,
        is_active=True,
        source=DocumentSource.MANUAL,
    )
    db.add(new_doc)
    db.flush()
    old_doc.replaced_by_document_id = new_doc.id

    work_item = ScreeningWorkItem(
        project_id=project.id,
        publication_id=canonical.id,
        stage=ScreeningStage.TITLE_ABSTRACT,
        slot_number=1,
        assigned_reviewer_id=reviewer.id,
        random_rank="r",
        status=WorkItemStatus.SUBMITTED,
    )
    db.add(work_item)
    db.flush()
    db.add(
        ScreeningDecision(
            work_item_id=work_item.id,
            reviewer_id=reviewer.id,
            outcome=ScreeningOutcome.INCLUDE,
            criteria_answers={criterion.id: "met"},
            version=1,
        )
    )
    db.add(
        FinalDecision(
            project_id=project.id,
            publication_id=canonical.id,
            stage=ScreeningStage.TITLE_ABSTRACT,
            outcome=ScreeningOutcome.INCLUDE,
            resolution_method="single_reviewer",
        )
    )

    extraction_item = ExtractionWorkItem(
        project_id=project.id, publication_id=canonical.id, random_rank="e"
    )
    db.add(extraction_item)
    db.flush()
    response = ExtractionResponse(
        work_item_id=extraction_item.id,
        reviewer_id=reviewer.id,
        form_version_id=version.id,
        answers={form_field.stable_key: 42},
        version=1,
    )
    db.add(response)

    schema = LlmSchemaVersion(
        project_id=project.id,
        version_number=1,
        status=SchemaStatus.PUBLISHED,
        based_on_form_version_id=version.id,
    )
    db.add(schema)
    db.flush()
    db.add(
        ProjectLlmSettings(project_id=project.id, enabled=True, current_schema_version_id=schema.id)
    )
    schema_field = LlmSchemaField(
        schema_version_id=schema.id,
        label="Sample size",
        instruction="Find it",
        field_type="number",
        mapped_extraction_field_key=form_field.stable_key,
        position=0,
    )
    db.add(schema_field)
    db.flush()
    run = LlmExtractionRun(
        project_id=project.id,
        publication_id=canonical.id,
        task_type=LlmTaskType.DATA_EXTRACTION,
        document_id=new_doc.id,
        schema_version_id=schema.id,
        model="test-model",
        prompt_template_version="v1",
        status=ProcessingStatus.COMPLETED,
        queued_at=utcnow(),
        raw_result={"documentId": new_doc.id},
    )
    db.add(run)
    db.flush()
    db.add(
        LlmFieldSuggestion(
            run_id=run.id,
            schema_field_id=schema_field.id,
            value=42,
            status=SuggestionStatus.EXPLICIT,
            evidence=[],
            evidence_validation_status="verified",
        )
    )
    finished_job = BackgroundJob(
        project_id=project.id, job_type="detect_duplicates", status=JobStatus.COMPLETED
    )
    db.add(finished_job)
    db.flush()
    run.background_job_id = finished_job.id
    db.add(
        AuditEvent(
            project_id=project.id,
            actor_id=owner.id,
            action="pdf.uploaded_manual",
            entity_type="publication_document",
            entity_id=new_doc.id,
            summary="Uploaded",
        )
    )
    db.commit()
    return {
        "project": project,
        "owner": owner,
        "reviewer": reviewer,
        "import_file": import_file,
        "pdf_keys": (old_key, new_key),
    }


def _rows_by_table(db: Session, project_id: str) -> dict[str, list[dict[str, Any]]]:
    connection = db.connection()
    return {
        step.table.name: [
            dict(row)
            for row in connection.execute(
                select(step.table).where(step.scope(project_id))
            ).mappings()
        ]
        for step in cloning._CLONE_PLAN
    }


def _strings(value: Any) -> set[str]:
    if isinstance(value, str):
        return {value}
    if isinstance(value, dict):
        return set().union(*(_strings(k) | _strings(v) for k, v in value.items()))
    if isinstance(value, (list, tuple)):
        return set().union(*(_strings(item) for item in value))
    return set()


def _clone(client, session_factory, project_id: str, csrf: str, name: str) -> str:
    response = client.post(
        f"/api/v1/projects/{project_id}/clone",
        json={"name": name},
        headers={"X-CSRF-Token": csrf},
    )
    assert response.status_code == 202, response.text
    job_id = response.json()["id"]
    assert execute_next_job(session_factory, worker_id="test-worker") is True
    jobs = client.get(f"/api/v1/projects/{project_id}/jobs").json()
    job = next(job for job in jobs if job["id"] == job_id)
    assert job["status"] == "completed", job
    return str(job["result"]["projectId"])


def test_every_table_is_classified_for_cloning() -> None:
    assert unclassified_tables() == set()


def test_clone_is_an_independent_deep_copy(client, db, session_factory, isolated_storage) -> None:
    data = build_populated_project(db, isolated_storage)
    source = data["project"]
    source_rows_before = _rows_by_table(db, source.id)
    csrf = login(client, "owner", "owner-password")

    clone_id = _clone(client, session_factory, source.id, csrf, "Copied Review")
    db.expire_all()

    clone = db.get(Project, clone_id)
    assert clone is not None
    assert clone.name == "Copied Review"
    assert clone.stage == ProjectStage.FULL_TEXT
    assert clone.configuration_ready is True

    source_rows = _rows_by_table(db, source.id)
    clone_rows = _rows_by_table(db, clone_id)
    source_ids = {row["id"] for rows in source_rows.values() for row in rows}
    clone_ids = {row["id"] for rows in clone_rows.values() for row in rows}
    assert source_ids.isdisjoint(clone_ids)

    for table in CLONED_TABLES - {"audit_events"}:
        assert len(clone_rows[table]) == len(source_rows[table]), table
    # The clone carries the source's history up to the copy, plus one event
    # recording the copy itself.
    assert len(clone_rows["audit_events"]) == len(source_rows_before["audit_events"]) + 2

    # The source project is unchanged apart from its own audit trail.
    for table, rows in source_rows_before.items():
        if table != "audit_events":
            assert len(source_rows[table]) == len(rows), table

    # Nothing in the clone points back into the source project -- not via a
    # foreign key, a plain id column or anything nested in JSON. (The one
    # exception is the provenance event naming the project it was copied from.)
    for table, rows in clone_rows.items():
        for row in rows:
            if row.get("action") == "project.created_from_clone":
                continue
            leaked = _strings(list(row.values())) & source_ids
            assert not leaked, (table, row)

    # Self-references and JSON references follow the copy.
    publications = {row["title"]: row for row in clone_rows["publications"]}
    assert publications["Merged away"]["merged_into_id"] == publications["Canonical"]["id"]
    documents = {row["original_filename"]: row for row in clone_rows["publication_documents"]}
    assert documents["old.pdf"]["replaced_by_document_id"] == documents["new.pdf"]["id"]
    (criterion,) = clone_rows["criteria"]
    (decision,) = clone_rows["screening_decisions"]
    assert decision["criteria_answers"] == {criterion["id"]: "met"}
    (form,) = clone_rows["review_forms"]
    (version,) = clone_rows["form_versions"]
    assert form["active_version_id"] == version["id"]
    (llm_settings,) = clone_rows["project_llm_settings"]
    (schema,) = clone_rows["llm_schema_versions"]
    assert llm_settings["current_schema_version_id"] == schema["id"]
    (run,) = clone_rows["llm_extraction_runs"]
    assert run["raw_result"] == {"documentId": documents["new.pdf"]["id"]}
    assert run["background_job_id"] is None
    # Stable form-field keys are identities within a form, not row ids.
    (field,) = clone_rows["form_fields"]
    (response,) = clone_rows["extraction_responses"]
    assert response["answers"] == {field["stable_key"]: 42}
    upload_events = [
        row for row in clone_rows["audit_events"] if row["action"] == "pdf.uploaded_manual"
    ]
    assert upload_events[0]["entity_id"] == documents["new.pdf"]["id"]

    # The person who made the copy owns it; everyone else keeps their role.
    memberships = {row["user_id"]: row for row in clone_rows["project_memberships"]}
    assert memberships[data["owner"].id]["is_owner"] is True
    assert memberships[data["reviewer"].id]["is_owner"] is False
    assert memberships[data["reviewer"].id]["can_title_abstract_screen"] is True

    # Files are copied, not shared.
    for row in clone_rows["publication_documents"]:
        assert row["storage_key"].startswith(f"projects/{clone_id}/")
        assert storage_path(row["storage_key"]).read_bytes() == PDF_BYTES
    (batch,) = clone_rows["import_batches"]
    assert Path(batch["stored_path"]) != data["import_file"]
    assert Path(batch["stored_path"]).read_text() == data["import_file"].read_text()

    actions = {
        event.action
        for event in db.scalars(
            select(AuditEvent).where(AuditEvent.project_id.in_([source.id, clone_id]))
        )
    }
    assert {"project.clone_requested", "project.cloned", "project.created_from_clone"} <= actions


def test_deleting_the_clone_leaves_the_source_files(
    client, db, session_factory, isolated_storage
) -> None:
    data = build_populated_project(db, isolated_storage)
    source = data["project"]
    csrf = login(client, "owner", "owner-password")
    clone_id = _clone(client, session_factory, source.id, csrf, "Throwaway")

    deleted = client.delete(f"/api/v1/projects/{clone_id}", headers={"X-CSRF-Token": csrf})
    assert deleted.status_code == 204
    for key in data["pdf_keys"]:
        assert storage_path(key).read_bytes() == PDF_BYTES
    assert data["import_file"].exists()
    db.expire_all()
    assert (
        db.scalar(
            select(func.count()).select_from(Publication).where(Publication.project_id == source.id)
        )
        == 2
    )


def test_clone_is_refused_while_project_jobs_are_unfinished(client, db, isolated_storage) -> None:
    data = build_populated_project(db, isolated_storage)
    source = data["project"]
    db.add(
        BackgroundJob(project_id=source.id, job_type="detect_duplicates", status=JobStatus.QUEUED)
    )
    db.commit()
    csrf = login(client, "owner", "owner-password")

    response = client.post(
        f"/api/v1/projects/{source.id}/clone",
        json={"name": "Too soon"},
        headers={"X-CSRF-Token": csrf},
    )

    assert response.status_code == 409
    assert response.json()["error"]["code"] == "project_jobs_running"


def test_only_project_managers_can_clone(client, db, isolated_storage) -> None:
    data = build_populated_project(db, isolated_storage)
    csrf = login(client, "reviewer", "reviewer-password")

    response = client.post(
        f"/api/v1/projects/{data['project'].id}/clone",
        json={"name": "Mine now"},
        headers={"X-CSRF-Token": csrf},
    )

    assert response.status_code == 403


def test_admin_who_is_not_a_member_owns_their_clone(
    client, db, session_factory, isolated_storage
) -> None:
    data = build_populated_project(db, isolated_storage)
    admin = create_user(db, "admin", "Admin", "admin-password", is_admin=True)
    db.commit()
    csrf = login(client, "admin", "admin-password")

    clone_id = _clone(client, session_factory, data["project"].id, csrf, "Admin copy")

    owners = db.scalars(
        select(ProjectMembership.user_id).where(
            ProjectMembership.project_id == clone_id,
            ProjectMembership.is_owner.is_(True),
        )
    ).all()
    assert owners == [admin.id]


def test_failed_clone_leaves_no_rows_or_files_behind(
    client, db, session_factory, isolated_storage, monkeypatch
) -> None:
    data = build_populated_project(db, isolated_storage)
    source = data["project"]
    csrf = login(client, "owner", "owner-password")
    real_copy_files = cloning._copy_files

    def copy_then_fail(state):
        real_copy_files(state)
        raise OSError("disk full")

    monkeypatch.setattr(cloning, "_copy_files", copy_then_fail)
    response = client.post(
        f"/api/v1/projects/{source.id}/clone",
        json={"name": "Doomed"},
        headers={"X-CSRF-Token": csrf},
    )
    assert response.status_code == 202
    assert execute_next_job(session_factory, worker_id="test-worker") is True

    db.expire_all()
    job = db.scalar(
        select(BackgroundJob).where(BackgroundJob.job_type == cloning.CLONE_PROJECT_JOB)
    )
    assert job is not None
    target_id = job.payload["target_project_id"]
    assert db.get(Project, target_id) is None
    assert not (isolated_storage.pdf_storage_path / "projects" / target_id).exists()
    assert not (isolated_storage.import_dir / target_id).exists()
    # Retrying after the fault is gone produces the full copy.
    monkeypatch.setattr(cloning, "_copy_files", real_copy_files)
    while execute_next_job(session_factory, worker_id="test-worker"):
        pass
    db.expire_all()
    assert db.get(Project, target_id) is not None


def test_copied_llm_and_analysis_results_stay_current_in_the_clone(
    client, db, session_factory, isolated_storage, monkeypatch
) -> None:
    from app.analysis.models import ResearchQuestionAnalysisRun, StageAnalysis
    from app.analysis.rq_jobs import compute_rq_fingerprint
    from app.analysis.service import compute_stage_stats, compute_stats_fingerprint
    from app.llm.task_service import run_is_stale, title_abstract_fingerprint
    from app.projects.models import ResearchQuestion

    settings = get_settings()
    monkeypatch.setattr(settings, "llm_enabled", True)
    monkeypatch.setattr(settings, "ollama_base_url", "http://ollama.example:11434")
    monkeypatch.setattr(settings, "ollama_model", "test-model:latest")
    data = build_populated_project(db, isolated_storage)
    source = data["project"]
    canonical = db.scalar(select(Publication).where(Publication.title == "Canonical"))
    question = ResearchQuestion(project_id=source.id, text="Does VR help?")
    db.add(question)
    db.flush()
    current_run = LlmExtractionRun(
        project_id=source.id,
        publication_id=canonical.id,
        task_type=LlmTaskType.TITLE_ABSTRACT_SCREENING,
        input_fingerprint=title_abstract_fingerprint(db, canonical),
        model="test-model",
        prompt_template_version="v1",
        status=ProcessingStatus.COMPLETED,
        queued_at=utcnow(),
    )
    stale_run = LlmExtractionRun(
        project_id=source.id,
        publication_id=canonical.id,
        task_type=LlmTaskType.TITLE_ABSTRACT_SCREENING,
        input_fingerprint="0" * 64,
        model="test-model",
        prompt_template_version="v1",
        status=ProcessingStatus.COMPLETED,
        queued_at=utcnow(),
    )
    db.add_all([current_run, stale_run])
    db.add(
        ResearchQuestionAnalysisRun(
            project_id=source.id,
            research_question_id=question.id,
            research_question_text=question.text,
            input_fingerprint=compute_rq_fingerprint(db, source.id, question),
            model="test-model",
            prompt_template_version="v1",
            status="completed",
            queued_at=utcnow(),
        )
    )
    db.add(
        StageAnalysis(
            project_id=source.id,
            stage="title_abstract_screening",
            summary="Narrative",
            stats_fingerprint=compute_stats_fingerprint(
                compute_stage_stats(db, source.id, "title_abstract_screening")
            ),
            generated_at=utcnow(),
        )
    )
    db.commit()
    assert not run_is_stale(db, current_run)
    csrf = login(client, "owner", "owner-password")

    clone_id = _clone(client, session_factory, source.id, csrf, "Copied Review")
    db.expire_all()

    copied_runs = db.scalars(
        select(LlmExtractionRun).where(
            LlmExtractionRun.project_id == clone_id,
            LlmExtractionRun.task_type == LlmTaskType.TITLE_ABSTRACT_SCREENING,
        )
    ).all()
    staleness = sorted(run_is_stale(db, run) for run in copied_runs)
    assert staleness == [False, True]
    (question_copy,) = db.scalars(
        select(ResearchQuestion).where(ResearchQuestion.project_id == clone_id)
    ).all()
    (rq_copy,) = db.scalars(
        select(ResearchQuestionAnalysisRun).where(
            ResearchQuestionAnalysisRun.project_id == clone_id
        )
    ).all()
    assert rq_copy.input_fingerprint == compute_rq_fingerprint(db, clone_id, question_copy)
    (analysis_copy,) = db.scalars(
        select(StageAnalysis).where(StageAnalysis.project_id == clone_id)
    ).all()
    assert analysis_copy.stats_fingerprint == compute_stats_fingerprint(
        compute_stage_stats(db, clone_id, "title_abstract_screening")
    )


def test_no_source_id_appears_anywhere_in_the_clone_even_inside_text(
    client, db, session_factory, isolated_storage
) -> None:
    data = build_populated_project(db, isolated_storage)
    source = data["project"]
    csrf = login(client, "owner", "owner-password")
    clone_id = _clone(client, session_factory, source.id, csrf, "Copied Review")
    db.expire_all()

    source_ids = {row["id"] for rows in _rows_by_table(db, source.id).values() for row in rows}
    for table, rows in _rows_by_table(db, clone_id).items():
        for row in rows:
            if row.get("action") == "project.created_from_clone":
                continue
            text = repr(row)
            leaked = {source_id for source_id in source_ids if source_id in text}
            assert not leaked, (table, row)


def _enable_email(monkeypatch) -> list[tuple[str, str, str]]:
    from app.core.config import Settings

    def email_settings(db=None) -> Settings:
        return Settings(
            _env_file=None,
            email_enabled=True,
            public_base_url="https://papertrail.example.org/",
            smtp_host="smtp.example.org",
            smtp_from_address="papertrail@example.org",
        )

    sent: list[tuple[str, str, str]] = []

    def fake_send(_settings, *, recipient, rendered) -> None:
        sent.append((recipient, rendered.subject, rendered.text_body))

    monkeypatch.setattr("app.notifications.service.effective_instance_settings", email_settings)
    monkeypatch.setattr("app.notifications.service.send_smtp_email", fake_send)
    return sent


def test_requester_is_emailed_when_the_copy_finishes(
    client, db, session_factory, isolated_storage, monkeypatch
) -> None:
    sent = _enable_email(monkeypatch)
    data = build_populated_project(db, isolated_storage)
    data["owner"].email = "owner@example.org"
    data["reviewer"].email = "reviewer@example.org"
    db.commit()
    csrf = login(client, "owner", "owner-password")

    clone_id = _clone(client, session_factory, data["project"].id, csrf, "Emailed Copy")
    while execute_next_job(session_factory, worker_id="test-worker"):
        pass

    assert len(sent) == 1
    recipient, subject, body = sent[0]
    assert recipient == "owner@example.org"
    assert "Emailed Copy" in subject
    assert f"/projects/{clone_id}" in body


def test_requester_is_emailed_once_when_the_copy_fails_for_good(
    client, db, session_factory, isolated_storage, monkeypatch
) -> None:
    sent = _enable_email(monkeypatch)
    data = build_populated_project(db, isolated_storage)
    data["owner"].email = "owner@example.org"
    db.commit()
    source = data["project"]
    csrf = login(client, "owner", "owner-password")

    def fail(_state):
        raise OSError("disk full")

    monkeypatch.setattr(cloning, "_copy_files", fail)
    response = client.post(
        f"/api/v1/projects/{source.id}/clone",
        json={"name": "Doomed"},
        headers={"X-CSRF-Token": csrf},
    )
    assert response.status_code == 202
    while execute_next_job(session_factory, worker_id="test-worker"):
        pass

    db.expire_all()
    job = db.scalar(
        select(BackgroundJob).where(BackgroundJob.job_type == cloning.CLONE_PROJECT_JOB)
    )
    assert job is not None and job.status == JobStatus.FAILED
    # Retried attempts stay silent; only the terminal failure is reported.
    assert len(sent) == 1
    recipient, subject, body = sent[0]
    assert recipient == "owner@example.org"
    assert "Source Review" in subject and "Doomed" in body
    assert "disk full" in body
    assert f"/projects/{source.id}/admin" in body
