from __future__ import annotations

from datetime import UTC, datetime, timedelta
from io import BytesIO

import pytest
from pypdf import PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject
from sqlalchemy import func, select

from app.accounts.service import create_user
from app.api.errors import DomainError
from app.audit.models import AuditEvent
from app.conflicts.service import record_final_decision
from app.core.config import get_settings
from app.extraction.models import ExtractionWorkItem
from app.extraction.service import submit_extraction
from app.forms.models import FormKind
from app.forms.service import add_field, create_form, rename_field, replace_field
from app.fulltext.documents import attach_staged_pdf
from app.fulltext.models import DocumentSource
from app.fulltext.storage import stage_pdf_stream
from app.jobs.models import BackgroundJob, JobStatus
from app.jobs.service import claim_job
from app.llm.evidence import verify_evidence
from app.llm.extraction import run_llm_extraction_job
from app.llm.models import (
    CriterionAssessment,
    DocumentPageText,
    DocumentTextExtraction,
    EvidenceStatus,
    ExtractionSuggestionReview,
    LlmExtractionRun,
    LlmFieldSuggestion,
    LlmTaskType,
    LlmValidationResult,
    ProcessingStatus,
    ProjectLlmSettings,
    SuggestionDisposition,
)
from app.llm.ollama import OllamaClient, OllamaResponse, OllamaTransientError
from app.llm.prompt import chunk_pages, extraction_messages, output_schema
from app.llm.schema_service import (
    initialize_from_form,
    mapping_state,
    project_settings,
    publish_schema,
)
from app.llm.service import LLM_JOB, TEXT_JOB, queue_preparation_if_eligible
from app.llm.task_execution import run_llm_task_job
from app.llm.task_service import (
    queue_title_abstract_suggestion,
    run_is_stale,
)
from app.llm.text_extraction import extract_document_text_job
from app.llm.validation import validate_result
from app.projects.models import (
    Criterion,
    CriterionKind,
    Project,
    ProjectMembership,
    ReviewType,
    ScreeningStage,
)
from app.publications.models import Publication
from app.screening.models import ScreeningWorkItem
from app.screening.service import submit_decision


def text_pdf(*page_texts: str) -> bytes:
    writer = PdfWriter()
    font = DictionaryObject(
        {
            NameObject("/Type"): NameObject("/Font"),
            NameObject("/Subtype"): NameObject("/Type1"),
            NameObject("/BaseFont"): NameObject("/Helvetica"),
        }
    )
    font_ref = writer._add_object(font)
    for text in page_texts:
        page = writer.add_blank_page(width=612, height=792)
        page[NameObject("/Resources")] = DictionaryObject(
            {NameObject("/Font"): DictionaryObject({NameObject("/F1"): font_ref})}
        )
        stream = DecodedStreamObject()
        escaped = text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
        stream.set_data(f"BT /F1 12 Tf 72 720 Td ({escaped}) Tj ET".encode())
        page[NameObject("/Contents")] = writer._add_object(stream)
    output = BytesIO()
    writer.write(output)
    return output.getvalue()


@pytest.fixture(autouse=True)
def llm_configuration(tmp_path, monkeypatch):
    settings = get_settings()
    monkeypatch.setattr(settings, "pdf_storage_path", tmp_path / "pdfs")
    settings.pdf_storage_path.mkdir()
    monkeypatch.setattr(settings, "llm_enabled", True)
    monkeypatch.setattr(settings, "ollama_base_url", "http://ollama.example:11434")
    monkeypatch.setattr(settings, "ollama_model", "test-model:latest")
    monkeypatch.setattr(settings, "llm_context_length", 8192)


def setup_llm_project(db):
    admin = create_user(db, "llm-admin", "LLM Admin", "secret-password", is_admin=True)
    reviewer = create_user(db, "llm-reviewer", "Reviewer", "reviewer-password")
    project = Project(
        name="LLM review", review_type=ReviewType.SYSTEMATIC_REVIEW, random_seed="seed"
    )
    db.add(project)
    db.flush()
    db.add(
        ProjectMembership(
            project_id=project.id,
            user_id=reviewer.id,
            can_extract=True,
            can_full_text_screen=True,
        )
    )
    form = create_form(db, "Extraction", FormKind.EXTRACTION, project_id=project.id)
    sample = add_field(db, form, "Sample size", "number")
    method = add_field(
        db, form, "Study method", "single_select", options=["experiment", "survey"]
    )
    publication = Publication(project_id=project.id, title="Example paper")
    db.add(publication)
    db.flush()
    staged = stage_pdf_stream(
        BytesIO(
            text_pdf("Introduction", "Twenty-four participants took part in the study.")
        ),
        "paper.pdf",
        import_batch_id="llm-test",
    )
    document = attach_staged_pdf(
        db,
        project_id=project.id,
        publication_id=publication.id,
        staged=staged,
        user_id=reviewer.id,
        source=DocumentSource.MANUAL,
    )
    schema = initialize_from_form(db, project.id, admin.id)
    publish_schema(db, schema, admin.id)
    llm_settings = project_settings(db, project.id, create=True)
    assert llm_settings is not None
    llm_settings.enabled = True
    db.commit()
    return admin, reviewer, project, publication, document, schema, sample, method


def include_title_abstract(db, publication):
    record_final_decision(
        db,
        publication.id,
        ScreeningStage.TITLE_ABSTRACT,
        "include",
        "agreement",
        None,
        None,
    )
    db.commit()


def test_schema_initializes_from_form_and_mapping_survives_rename(db) -> None:
    admin, _, project, _, _, schema, sample, _ = setup_llm_project(db)
    assert [field.mapped_extraction_field_key for field in schema.fields] == [
        sample.stable_key,
        schema.fields[1].mapped_extraction_field_key,
    ]
    form = db.query(type(sample.version.form)).filter_by(project_id=project.id).one()
    rename_field(db, form, sample.stable_key, "Evaluation sample size")
    db.commit()
    assert mapping_state(db, project.id, schema.fields[0]) == "active"

    replace_field(db, form, sample.stable_key, "long_text", label="Sample narrative")
    db.commit()
    assert mapping_state(db, project.id, schema.fields[0]) == "outdated"
    assert admin.id
    actions = set(
        db.scalars(select(AuditEvent.action).where(AuditEvent.project_id == project.id))
    )
    assert {"llm.schema_created", "llm.schema_published"}.issubset(actions)


def test_trigger_waits_for_title_include_and_is_idempotent(db) -> None:
    _, _, _, publication, document, _, _, _ = setup_llm_project(db)
    assert queue_preparation_if_eligible(db, publication.id) is None
    assert db.scalar(select(func.count()).select_from(BackgroundJob)) == 0

    include_title_abstract(db, publication)
    jobs = list(
        db.scalars(select(BackgroundJob).where(BackgroundJob.job_type == TEXT_JOB))
    )
    assert len(jobs) == 1
    assert jobs[0].payload["document_id"] == document.id
    queue_preparation_if_eligible(db, publication.id)
    db.commit()
    assert (
        db.scalar(
            select(func.count())
            .select_from(BackgroundJob)
            .where(BackgroundJob.job_type == TEXT_JOB)
        )
        == 1
    )


def test_page_aware_text_extraction_and_repeated_job_are_idempotent(db) -> None:
    _, _, _, publication, document, _, _, _ = setup_llm_project(db)
    include_title_abstract(db, publication)
    job = db.scalar(select(BackgroundJob).where(BackgroundJob.job_type == TEXT_JOB))
    result = extract_document_text_job(db, job)
    db.commit()
    extraction = db.get(DocumentTextExtraction, result["textExtractionId"])
    pages = list(
        db.scalars(
            select(DocumentPageText)
            .where(DocumentPageText.text_extraction_id == extraction.id)
            .order_by(DocumentPageText.page_number)
        )
    )
    assert extraction.document_id == document.id
    assert extraction.status == ProcessingStatus.COMPLETED
    assert [(page.page_number, page.text.strip()) for page in pages] == [
        (1, "Introduction"),
        (2, "Twenty-four participants took part in the study."),
    ]
    again = extract_document_text_job(db, job)
    db.commit()
    assert again["idempotent"] is True
    assert db.scalar(select(func.count()).select_from(DocumentPageText)) == 2
    assert (
        db.scalar(
            select(func.count())
            .select_from(BackgroundJob)
            .where(BackgroundJob.job_type == LLM_JOB)
        )
        == 1
    )


def test_image_only_pdf_is_marked_unsupported_without_llm_job(db) -> None:
    _, _, _, publication, document, _, _, _ = setup_llm_project(db)
    # Replace storage contents with a valid page that has no text.
    writer = PdfWriter()
    writer.add_blank_page(width=72, height=72)
    stream = BytesIO()
    writer.write(stream)
    from app.fulltext.storage import storage_path

    storage_path(document.storage_key).write_bytes(stream.getvalue())
    include_title_abstract(db, publication)
    job = db.scalar(select(BackgroundJob).where(BackgroundJob.job_type == TEXT_JOB))
    result = extract_document_text_job(db, job)
    db.commit()
    assert result["status"] == ProcessingStatus.UNSUPPORTED
    assert (
        db.scalar(
            select(func.count())
            .select_from(BackgroundJob)
            .where(BackgroundJob.job_type == LLM_JOB)
        )
        == 0
    )


class FakeOllama:
    def __init__(self, content):
        self.content = content
        self.calls = []

    def chat(self, *, messages, output_schema):
        self.calls.append((messages, output_schema))
        return OllamaResponse(
            content=self.content,
            metrics={
                "total_duration": 100,
                "load_duration": 10,
                "prompt_eval_count": 200,
                "prompt_eval_duration": 50,
                "eval_count": 20,
                "eval_duration": 30,
            },
        )


def prepared_run(db):
    (
        _,
        reviewer,
        project,
        publication,
        document,
        schema,
        sample,
        method,
    ) = setup_llm_project(db)
    include_title_abstract(db, publication)
    text_job = db.scalar(
        select(BackgroundJob).where(BackgroundJob.job_type == TEXT_JOB)
    )
    extract_document_text_job(db, text_job)
    db.commit()
    run = db.scalar(select(LlmExtractionRun))
    llm_job = db.get(BackgroundJob, run.background_job_id)
    return (
        reviewer,
        project,
        publication,
        document,
        schema,
        sample,
        method,
        run,
        llm_job,
    )


def test_ollama_job_uses_structured_output_and_verifies_evidence(
    db, monkeypatch
) -> None:
    _, _, _, document, schema, sample, method, run, job = prepared_run(db)
    fake = FakeOllama(
        {
            "fields": {
                sample.stable_key: {
                    "value": 24,
                    "status": "explicit",
                    "evidence": [
                        {
                            "page": 2,
                            "quote": "Twenty-four participants took part in the study.",
                        }
                    ],
                },
                method.stable_key: {
                    "value": None,
                    "status": "not_found",
                    "evidence": [],
                },
            }
        }
    )
    monkeypatch.setattr("app.llm.extraction.create_ollama_client", lambda: fake)
    result = run_llm_extraction_job(db, job)
    db.commit()
    db.refresh(run)
    assert result["status"] == "completed"
    assert run.document_id == document.id
    assert run.schema_version_id == schema.id
    assert run.model == "test-model:latest"
    assert run.model_configuration == {
        "temperature": 0,
        "think": False,
        "contextLength": 8192,
    }
    assert run.prompt_eval_count == 200
    suggestion = db.scalar(
        select(LlmFieldSuggestion).where(
            LlmFieldSuggestion.mapped_extraction_field_key == sample.stable_key
        )
    )
    assert suggestion.value == 24
    assert suggestion.evidence_validation_status == EvidenceStatus.VERIFIED
    request_messages, request_schema = fake.calls[0]
    assert "--- PDF PAGE 2 ---" in request_messages[1]["content"]
    assert sample.stable_key in request_schema["properties"]["fields"]["properties"]


def test_structured_response_rejects_types_enums_unknown_fields_and_inference(
    db,
) -> None:
    *_, schema, sample, method = setup_llm_project(db)[0:8]
    fields = schema.fields
    base = {
        "fields": {
            sample.stable_key: {"value": 24, "status": "explicit", "evidence": []},
            method.stable_key: {
                "value": "experiment",
                "status": "explicit",
                "evidence": [],
            },
        }
    }
    assert validate_result(base, fields).fields[sample.stable_key].value == 24
    wrong_type = {
        "fields": {
            **base["fields"],
            sample.stable_key: {"value": "24", "status": "explicit", "evidence": []},
        }
    }
    with pytest.raises(DomainError):
        validate_result(wrong_type, fields)
    invalid_enum = {
        "fields": {
            **base["fields"],
            method.stable_key: {
                "value": "interview",
                "status": "explicit",
                "evidence": [],
            },
        }
    }
    with pytest.raises(DomainError):
        validate_result(invalid_enum, fields)
    with pytest.raises(DomainError):
        validate_result(
            {
                "fields": {
                    **base["fields"],
                    "unknown": base["fields"][sample.stable_key],
                }
            },
            fields,
        )
    inferred = {
        "fields": {
            **base["fields"],
            sample.stable_key: {"value": 24, "status": "inferred", "evidence": []},
        }
    }
    with pytest.raises(DomainError):
        validate_result(inferred, fields)


def test_evidence_verification_never_marks_wrong_page_or_fabrication_verified() -> None:
    pages = {1: "Twenty four participants joined.", 2: "Results are reported here."}
    exact, exact_status = verify_evidence(
        [{"page": 1, "quote": "Twenty  four participants joined."}],
        pages,
        required=True,
        max_items=3,
        max_quote_chars=500,
    )
    wrong, wrong_status = verify_evidence(
        [{"page": 2, "quote": "Twenty four participants joined."}],
        pages,
        required=True,
        max_items=3,
        max_quote_chars=500,
    )
    assert exact[0]["verified"] is True and exact_status == EvidenceStatus.VERIFIED
    assert wrong[0]["verified"] is False and wrong_status == EvidenceStatus.UNVERIFIED


def test_long_documents_are_page_aware_and_chunked_without_losing_page_numbers(
    db,
) -> None:
    _, _, _, _, _, schema, _, _ = setup_llm_project(db)
    chunks = chunk_pages(
        [(number, "x" * 2500) for number in range(1, 9)],
        context_length=4096,
        instruction_chars=1000,
        field_count=2,
    )
    assert len(chunks) > 1
    assert "--- PDF PAGE 1 ---" in chunks[0]
    assert any("--- PDF PAGE 8 ---" in chunk for chunk in chunks)
    messages = extraction_messages(schema.fields, chunks[0])
    schema_json = output_schema(schema.fields, 3, 500)
    assert messages[0]["role"] == "system"
    assert schema_json["additionalProperties"] is False


def test_transient_ollama_failure_is_retryable_and_does_not_create_suggestions(
    db, monkeypatch
) -> None:
    *_, run, job = prepared_run(db)

    class Offline:
        def chat(self, **_):
            raise OllamaTransientError("offline")

    monkeypatch.setattr("app.llm.extraction.create_ollama_client", lambda: Offline())
    with pytest.raises(Exception, match="offline"):
        run_llm_extraction_job(db, job)
    db.rollback()
    assert db.scalar(select(func.count()).select_from(LlmFieldSuggestion)) == 0
    assert db.get(LlmExtractionRun, run.id).status == ProcessingStatus.PENDING


def test_invalid_structured_output_gets_one_repair_then_fails_cleanly(
    db, monkeypatch
) -> None:
    *_, sample, method, run, job = prepared_run(db)
    invalid = FakeOllama(
        {
            "fields": {
                sample.stable_key: {
                    "value": "not a number",
                    "status": "explicit",
                    "evidence": [],
                },
                method.stable_key: {
                    "value": "invalid option",
                    "status": "explicit",
                    "evidence": [],
                },
            }
        }
    )
    monkeypatch.setattr("app.llm.extraction.create_ollama_client", lambda: invalid)
    result = run_llm_extraction_job(db, job)
    db.commit()
    assert result["status"] == "failed"
    assert len(invalid.calls) == 2
    assert db.get(LlmExtractionRun, run.id).error_type == "invalid_response"
    assert db.scalar(select(func.count()).select_from(LlmFieldSuggestion)) == 0


def test_reviewer_submission_preserves_llm_output_and_records_provenance(
    db, monkeypatch
) -> None:
    reviewer, project, publication, _, _, sample, method, run, job = prepared_run(db)
    fake = FakeOllama(
        {
            "fields": {
                sample.stable_key: {"value": 24, "status": "explicit", "evidence": []},
                method.stable_key: {
                    "value": "experiment",
                    "status": "explicit",
                    "evidence": [],
                },
            }
        }
    )
    monkeypatch.setattr("app.llm.extraction.create_ollama_client", lambda: fake)
    run_llm_extraction_job(db, job)
    item = ExtractionWorkItem(
        project_id=project.id,
        publication_id=publication.id,
        assigned_reviewer_id=reviewer.id,
        random_rank="rank",
        draft={sample.stable_key: 22},
    )
    db.add(item)
    db.flush()
    response = submit_extraction(
        db,
        item,
        reviewer.id,
        {sample.stable_key: 22, method.stable_key: "experiment"},
    )
    db.commit()
    reviews = {
        review.extraction_field_key: review
        for review in db.scalars(
            select(ExtractionSuggestionReview).where(
                ExtractionSuggestionReview.extraction_response_id == response.id
            )
        )
    }
    assert reviews[sample.stable_key].disposition == SuggestionDisposition.MODIFIED
    assert reviews[method.stable_key].disposition == SuggestionDisposition.ACCEPTED
    assert response.answers[sample.stable_key] == 22
    assert (
        db.get(LlmExtractionRun, run.id).raw_result["fields"][sample.stable_key][
            "value"
        ]
        == 24
    )


def test_project_disabled_prevents_trigger(db) -> None:
    _, _, project, publication, _, _, _, _ = setup_llm_project(db)
    settings = db.scalar(
        select(ProjectLlmSettings).where(ProjectLlmSettings.project_id == project.id)
    )
    settings.enabled = False
    include_title_abstract(db, publication)
    assert db.scalar(select(func.count()).select_from(BackgroundJob)) == 0


def test_llm_admin_settings_schema_and_connection_api(client, db, monkeypatch) -> None:
    admin, _, project, _, _, schema, _, _ = setup_llm_project(db)
    csrf = client.post(
        "/api/v1/auth/login",
        json={"username": admin.username, "password": "secret-password"},
    ).json()["csrfToken"]

    settings_response = client.get(f"/api/v1/projects/{project.id}/llm/settings")
    assert settings_response.status_code == 200
    assert settings_response.json()["provider"] == "Ollama"
    assert "apiKey" not in settings_response.text
    schema_response = client.get(f"/api/v1/projects/{project.id}/llm/schema")
    assert schema_response.status_code == 200
    assert schema_response.json()["schema"]["id"] == schema.id

    class ConnectionClient:
        def test_connection(self):
            return {
                "available": True,
                "modelAvailable": True,
                "model": "test-model:latest",
            }

    monkeypatch.setattr(
        "app.llm.routes.create_ollama_client", lambda: ConnectionClient()
    )
    tested = client.post(
        f"/api/v1/projects/{project.id}/llm/test",
        headers={"X-CSRF-Token": csrf},
    )
    assert tested.status_code == 200
    assert tested.json()["modelAvailable"] is True


def test_suggestions_are_visible_only_to_assigned_reviewer(
    client, db, monkeypatch
) -> None:
    reviewer, project, publication, _, _, sample, method, _, job = prepared_run(db)
    outsider = create_user(db, "llm-outsider", "Outsider", "outsider-password")
    db.add(
        ProjectMembership(project_id=project.id, user_id=outsider.id, can_extract=True)
    )
    item = ExtractionWorkItem(
        project_id=project.id,
        publication_id=publication.id,
        assigned_reviewer_id=reviewer.id,
        random_rank="assigned",
    )
    db.add(item)
    db.commit()
    fake = FakeOllama(
        {
            "fields": {
                sample.stable_key: {"value": 24, "status": "explicit", "evidence": []},
                method.stable_key: {
                    "value": None,
                    "status": "not_found",
                    "evidence": [],
                },
            }
        }
    )
    monkeypatch.setattr("app.llm.extraction.create_ollama_client", lambda: fake)
    run_llm_extraction_job(db, job)
    db.commit()

    client.post(
        "/api/v1/auth/login",
        json={"username": reviewer.username, "password": "reviewer-password"},
    )
    own = client.get(
        f"/api/v1/projects/{project.id}/extraction/{item.id}/llm-suggestions"
    )
    assert own.status_code == 200
    assert own.json()["state"] == "ready"
    assert own.json()["suggestions"][0]["mappedExtractionFieldKey"] in {
        sample.stable_key,
        method.stable_key,
    }

    client.post(
        "/api/v1/auth/login",
        json={"username": outsider.username, "password": "outsider-password"},
    )
    denied = client.get(
        f"/api/v1/projects/{project.id}/extraction/{item.id}/llm-suggestions"
    )
    assert denied.status_code == 403


def test_full_text_exclusion_cancels_queued_inference(db) -> None:
    _, _, _, publication, _, _, _, _ = setup_llm_project(db)
    include_title_abstract(db, publication)
    text_job = db.scalar(
        select(BackgroundJob).where(BackgroundJob.job_type == TEXT_JOB)
    )
    extract_document_text_job(db, text_job)
    db.commit()
    run = db.scalar(select(LlmExtractionRun))
    llm_job = db.get(BackgroundJob, run.background_job_id)
    assert run.status == ProcessingStatus.PENDING

    record_final_decision(
        db,
        publication.id,
        ScreeningStage.FULL_TEXT,
        "exclude",
        "agreement",
        None,
        None,
    )
    db.commit()
    assert run.status == ProcessingStatus.CANCELLED
    assert llm_job.status == JobStatus.CANCELLED


def test_ollama_native_request_disables_streaming_and_thinking(monkeypatch) -> None:
    settings = get_settings()
    captured = {}

    class Response:
        def raise_for_status(self):
            return None

        def json(self):
            return {
                "message": {"content": '{"fields": {}}'},
                "prompt_eval_count": 12,
            }

    def post(url, **kwargs):
        captured["url"] = url
        captured.update(kwargs)
        return Response()

    monkeypatch.setattr("app.llm.ollama.httpx.post", post)
    result = OllamaClient(settings).chat(
        messages=[{"role": "user", "content": "paper"}],
        output_schema={"type": "object"},
    )
    body = captured["json"]
    assert captured["url"] == "http://ollama.example:11434/api/chat"
    assert body["model"] == "test-model:latest"
    assert body["stream"] is False
    assert body["think"] is False
    assert body["format"] == {"type": "object"}
    assert body["options"]["temperature"] == 0
    assert result.metrics["prompt_eval_count"] == 12


def test_worker_type_filter_keeps_gpu_jobs_for_dedicated_worker(db) -> None:
    generic = BackgroundJob(job_type="parse_import", payload={})
    inference = BackgroundJob(job_type=LLM_JOB, payload={"run_id": "run"})
    db.add_all([generic, inference])
    db.commit()
    claimed_generic = claim_job(db, "normal", excluded_job_types={LLM_JOB})
    assert claimed_generic.id == generic.id
    db.commit()
    claimed_llm = claim_job(db, "gpu", allowed_job_types={LLM_JOB})
    assert claimed_llm.id == inference.id


def test_dedicated_worker_recovers_an_expired_llm_lease(db) -> None:
    job = BackgroundJob(
        job_type=LLM_JOB,
        payload={"run_id": "run"},
        status=JobStatus.RUNNING,
        attempts=1,
        max_attempts=3,
        locked_by="dead-worker",
        lease_until=datetime.now(UTC) - timedelta(seconds=1),
    )
    db.add(job)
    db.commit()
    recovered = claim_job(db, "replacement-worker", allowed_job_types={LLM_JOB})
    assert recovered.id == job.id
    assert recovered.locked_by == "replacement-worker"
    assert recovered.attempts == 2


def test_replacing_pdf_creates_new_text_chain_and_preserves_old_text(db) -> None:
    _, reviewer, _, publication, first_document, _, _, _ = setup_llm_project(db)
    include_title_abstract(db, publication)
    first_job = db.scalar(
        select(BackgroundJob).where(BackgroundJob.job_type == TEXT_JOB)
    )
    extract_document_text_job(db, first_job)
    db.commit()
    first_extraction = db.scalar(
        select(DocumentTextExtraction).where(
            DocumentTextExtraction.document_id == first_document.id
        )
    )
    staged = stage_pdf_stream(
        BytesIO(text_pdf("Replacement PDF has independently extracted text.")),
        "replacement.pdf",
        import_batch_id="replacement-test",
    )
    second_document = attach_staged_pdf(
        db,
        project_id=publication.project_id,
        publication_id=publication.id,
        staged=staged,
        user_id=reviewer.id,
        source=DocumentSource.MANUAL,
        replace=True,
    )
    db.commit()
    second_job = next(
        job
        for job in db.scalars(
            select(BackgroundJob).where(
                BackgroundJob.job_type == TEXT_JOB,
                BackgroundJob.status == JobStatus.QUEUED,
            )
        )
        if job.payload["document_id"] == second_document.id
    )
    extract_document_text_job(db, second_job)
    db.commit()
    assert first_extraction.status == ProcessingStatus.COMPLETED
    assert (
        db.scalar(
            select(DocumentTextExtraction.id).where(
                DocumentTextExtraction.document_id == second_document.id
            )
        )
        != first_extraction.id
    )


def test_title_suggestion_is_generated_independently_and_revealed_only_after_decision(
    client, db, monkeypatch
) -> None:
    _, reviewer, project, publication, _, _, _, _ = setup_llm_project(db)
    membership = db.scalar(
        select(ProjectMembership).where(
            ProjectMembership.project_id == project.id,
            ProjectMembership.user_id == reviewer.id,
        )
    )
    membership.can_title_abstract_screen = True
    criterion = Criterion(
        project_id=project.id,
        kind=CriterionKind.INCLUSION,
        text="Reports an empirical evaluation",
        position=0,
    )
    db.add(criterion)
    settings = project_settings(db, project.id)
    settings.title_abstract_screening_enabled = True
    item = ScreeningWorkItem(
        project_id=project.id,
        publication_id=publication.id,
        stage=ScreeningStage.TITLE_ABSTRACT,
        slot_number=1,
        assigned_reviewer_id=reviewer.id,
        reserved_by_id=reviewer.id,
        random_rank="title-llm",
    )
    db.add(item)
    db.commit()

    run = queue_title_abstract_suggestion(db, publication.id)
    assert run is not None
    fake = FakeOllama(
        {
            "suggested_decision": "uncertain",
            "confidence": "low",
            "criteria": {
                criterion.id: {
                    "assessment": "unclear",
                    "explanation": "The abstract does not describe the evaluation.",
                    "evidence": [],
                }
            },
            "reasoning_summary": "The available metadata is insufficient.",
        }
    )
    monkeypatch.setattr("app.llm.task_execution.create_ollama_client", lambda: fake)
    job = db.get(BackgroundJob, run.background_job_id)
    run_llm_task_job(db, job)
    db.commit()

    csrf = client.post(
        "/api/v1/auth/login",
        json={"username": reviewer.username, "password": "reviewer-password"},
    ).json()["csrfToken"]
    path = f"/api/v1/projects/{project.id}/screening/work-items/{item.id}/llm-title-abstract"
    hidden = client.get(path)
    assert hidden.status_code == 200
    assert hidden.json() == {
        "state": "hidden",
        "hidden": True,
        "runId": None,
        "documentId": None,
        "model": None,
        "promptVersion": None,
        "stale": False,
        "error": None,
        "suggestedDecision": None,
        "confidence": None,
        "reasoningSummary": None,
        "criteria": [],
    }
    assert "uncertain" not in hidden.text

    submit_decision(db, item, reviewer.id, "include", {criterion.id: True}, None)
    db.commit()
    revealed = client.get(path, headers={"X-CSRF-Token": csrf})
    assert revealed.status_code == 200
    assert revealed.json()["suggestedDecision"] == "uncertain"
    assert revealed.json()["criteria"][0]["assessment"] == "unclear"

    criterion.text = "Reports an empirical evaluation with participants"
    db.commit()
    assert client.get(path).json()["stale"] is True

    outsider = create_user(db, "screening-outsider", "Outsider", "outsider-password")
    db.commit()
    client.post(
        "/api/v1/auth/login",
        json={"username": outsider.username, "password": "outsider-password"},
    )
    assert client.get(path).status_code == 403


def test_full_text_assistance_verifies_page_evidence(db, monkeypatch) -> None:
    _, _, project, publication, _, _, _, _ = setup_llm_project(db)
    criterion = Criterion(
        project_id=project.id,
        kind=CriterionKind.INCLUSION,
        text="Uses human participants",
        position=0,
    )
    db.add(criterion)
    settings = project_settings(db, project.id)
    settings.full_text_screening_enabled = True
    db.commit()
    include_title_abstract(db, publication)
    text_job = db.scalar(
        select(BackgroundJob).where(BackgroundJob.job_type == TEXT_JOB)
    )
    extraction = extract_document_text_job(db, text_job)
    db.commit()
    run = db.scalar(
        select(LlmExtractionRun).where(
            LlmExtractionRun.task_type == LlmTaskType.FULL_TEXT_SCREENING
        )
    )
    assert run is not None
    fake = FakeOllama(
        {
            "suggested_decision": "include",
            "confidence": "high",
            "criteria": {
                criterion.id: {
                    "assessment": "met",
                    "explanation": "Participants are reported.",
                    "evidence": [
                        {
                            "page": 2,
                            "section": "Methods",
                            "quote": "Twenty-four participants took part in the study.",
                        }
                    ],
                }
            },
            "reasoning_summary": "The eligibility criterion is supported.",
        }
    )
    monkeypatch.setattr("app.llm.task_execution.create_ollama_client", lambda: fake)
    run_llm_task_job(db, db.get(BackgroundJob, run.background_job_id))
    db.commit()
    db.refresh(run)
    suggestion = run.criterion_suggestions[0]
    assert extraction["status"] == "completed"
    assert suggestion.assessment == CriterionAssessment.MET
    assert suggestion.evidence_validation_status == EvidenceStatus.VERIFIED
    assert suggestion.evidence[0] == {
        "page": 2,
        "quote": "Twenty-four participants took part in the study.",
        "section": "Methods",
        "verified": True,
    }


def test_validation_uses_human_values_and_never_changes_extraction(
    db, monkeypatch
) -> None:
    _, reviewer, project, publication, _, _, sample, method = setup_llm_project(db)
    settings = project_settings(db, project.id)
    settings.extraction_validation_enabled = True
    include_title_abstract(db, publication)
    text_job = db.scalar(
        select(BackgroundJob).where(BackgroundJob.job_type == TEXT_JOB)
    )
    extract_document_text_job(db, text_job)
    item = ExtractionWorkItem(
        project_id=project.id,
        publication_id=publication.id,
        assigned_reviewer_id=reviewer.id,
        random_rank="validation",
    )
    db.add(item)
    db.flush()
    human_answers = {sample.stable_key: 22, method.stable_key: "experiment"}
    response = submit_extraction(db, item, reviewer.id, human_answers)
    db.commit()
    run = db.scalar(
        select(LlmExtractionRun).where(
            LlmExtractionRun.task_type == LlmTaskType.EXTRACTION_VALIDATION
        )
    )
    assert run is not None
    fake = FakeOllama(
        {
            "fields": {
                sample.stable_key: {
                    "assessment": "contradicted",
                    "explanation": "The paper reports 24 rather than 22.",
                    "evidence": [
                        {
                            "page": 2,
                            "section": "Methods",
                            "quote": "Twenty-four participants took part in the study.",
                        }
                    ],
                },
                method.stable_key: {
                    "assessment": "not_verifiable",
                    "explanation": "No explicit study-method label was found.",
                    "evidence": [],
                },
            }
        }
    )
    monkeypatch.setattr("app.llm.task_execution.create_ollama_client", lambda: fake)
    run_llm_task_job(db, db.get(BackgroundJob, run.background_job_id))
    db.commit()
    db.refresh(response)
    assert response.answers == human_answers
    results = {
        result.extraction_field_key: result
        for result in db.scalars(
            select(LlmValidationResult).where(LlmValidationResult.run_id == run.id)
        )
    }
    assert results[sample.stable_key].assessment == "contradicted"
    assert results[sample.stable_key].value_snapshot == 22
    assert results[method.stable_key].assessment == "not_verifiable"

    corrected = {sample.stable_key: 24, method.stable_key: "experiment"}
    submit_extraction(db, item, reviewer.id, corrected)
    db.commit()
    assert run_is_stale(db, run) is True
    assert response.answers == human_answers
