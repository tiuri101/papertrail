from __future__ import annotations

from datetime import UTC, datetime, timedelta
from io import BytesIO

import pytest
from pypdf import PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject
from sqlalchemy import func, select

from app.accounts.service import create_user
from app.analysis.jobs import STAGE_ANALYSIS_JOB
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
from app.jobs.registry import LLM_JOB_TYPES
from app.jobs.service import claim_job, enqueue_job
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
from app.llm.service import (
    LLM_JOB_DATA_EXTRACTION,
    TEXT_JOB,
    cancel_task_type_jobs,
    queue_preparation_if_eligible,
)
from app.llm.task_execution import run_llm_task_job
from app.llm.task_service import (
    queue_title_abstract_suggestion,
    run_is_stale,
)
from app.llm.task_validation import derive_screening_recommendation
from app.llm.text_extraction import extract_document_text_job
from app.llm.validation import validate_result
from app.projects.models import (
    AllocationMode,
    Criterion,
    CriterionKind,
    Project,
    ProjectMembership,
    ReviewType,
    ScreeningConfig,
    ScreeningStage,
)
from app.publications.models import Publication
from app.screening.models import ScreeningWorkItem
from app.screening.service import create_screening_work_items, submit_decision


@pytest.mark.parametrize(
    ("criteria", "decision", "confidence"),
    [
        (
            [
                (CriterionKind.INCLUSION, "not_met"),
                (CriterionKind.EXCLUSION, "unclear"),
            ],
            "exclude",
            "medium",
        ),
        (
            [
                (CriterionKind.INCLUSION, "met"),
                (CriterionKind.EXCLUSION, "not_met"),
            ],
            "include",
            "high",
        ),
        (
            [
                (CriterionKind.INCLUSION, "met"),
                (CriterionKind.EXCLUSION, "unclear"),
            ],
            "uncertain",
            "low",
        ),
    ],
)
def test_screening_recommendation_is_derived_from_criteria(
    criteria: list[tuple[CriterionKind, str]], decision: str, confidence: str
) -> None:
    recommendation = derive_screening_recommendation(criteria)

    assert recommendation.suggested_decision == decision
    assert recommendation.confidence == confidence


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


def test_message_builders_honor_base_prompt_override() -> None:
    from app.llm.prompt import SYSTEM_PROMPT, extraction_messages
    from app.llm.task_prompt import (
        SCREENING_SYSTEM_PROMPT,
        VALIDATION_SYSTEM_PROMPT,
        title_abstract_messages,
        validation_messages,
    )

    publication = Publication(id="pub-1", project_id="proj-1", title="Example paper")
    criterion = Criterion(
        id="crit-1",
        project_id="proj-1",
        kind=CriterionKind.INCLUSION,
        text="Is relevant.",
    )
    research_questions = []

    default_screening = title_abstract_messages(
        publication, [criterion], research_questions
    )
    assert default_screening[0]["content"].startswith(SCREENING_SYSTEM_PROMPT)

    overridden_screening = title_abstract_messages(
        publication,
        [criterion],
        research_questions,
        base_prompt="Custom screening base.",
    )
    assert overridden_screening[0]["content"] == "Custom screening base."
    assert SCREENING_SYSTEM_PROMPT not in overridden_screening[0]["content"]

    default_extraction = extraction_messages([], research_questions, "paper text")
    assert default_extraction[0]["content"].startswith(SYSTEM_PROMPT)
    overridden_extraction = extraction_messages(
        [], research_questions, "paper text", base_prompt="Custom extraction base."
    )
    assert overridden_extraction[0]["content"] == "Custom extraction base."

    default_validation = validation_messages([], research_questions, "paper text")
    assert default_validation[0]["content"].startswith(VALIDATION_SYSTEM_PROMPT)
    overridden_validation = validation_messages(
        [], research_questions, "paper text", base_prompt="Custom validation base."
    )
    assert overridden_validation[0]["content"] == "Custom validation base."


def test_research_questions_context_is_shared_between_prompt_modules() -> None:
    from app.llm.prompt import research_questions_context
    from app.llm.task_prompt import _research_questions_context
    from app.projects.models import ResearchQuestion

    # task_prompt.py must reuse prompt.py's implementation rather than
    # redefining it -- the two previously-separate call sites are now
    # literally the same function.
    assert _research_questions_context is research_questions_context

    questions = [
        ResearchQuestion(id="rq-1", project_id="proj-1", text="What effect?"),
        ResearchQuestion(id="rq-2", project_id="proj-1", text="In which population?"),
    ]
    assert research_questions_context(questions) == _research_questions_context(
        questions
    )


def test_evidence_item_is_shared_across_validation_modules() -> None:
    from app.llm.evidence import EvidenceItem
    from app.llm.task_validation import CriterionResult, ValidationFieldResult
    from app.llm.validation import FieldResult

    field_result = FieldResult(
        value="x", status="explicit", evidence=[{"page": 1, "quote": "hello"}]
    )
    assert isinstance(field_result.evidence[0], EvidenceItem)

    criterion_result = CriterionResult(
        assessment="met",
        explanation="because",
        evidence=[{"page": 2, "quote": "world"}],
    )
    assert isinstance(criterion_result.evidence[0], EvidenceItem)

    validation_result = ValidationFieldResult(
        assessment="supported",
        explanation="because",
        evidence=[{"page": 3, "quote": "!"}],
    )
    assert isinstance(validation_result.evidence[0], EvidenceItem)


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


def include_full_text(db, publication):
    record_final_decision(
        db,
        publication.id,
        ScreeningStage.FULL_TEXT,
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


def test_bulk_reanalysis_marks_every_queued_job_with_the_same_bulk(client, db) -> None:
    admin, _, project, publication, _, _, _, _ = setup_llm_project(db)
    include_title_abstract(db, publication)
    include_full_text(db, publication)
    csrf = client.post(
        "/api/v1/auth/login",
        json={"username": admin.username, "password": "secret-password"},
    ).json()["csrfToken"]

    response = client.post(
        f"/api/v1/projects/{project.id}/llm/runs/reanalyze",
        json={"taskType": "data_extraction"},
        headers={"X-CSRF-Token": csrf},
    )

    assert response.status_code == 200
    bulk_id = response.json()["bulkId"]
    assert response.json()["queued"] == 1
    text_job = db.scalar(
        select(BackgroundJob).where(BackgroundJob.job_type == TEXT_JOB)
    )
    assert text_job is not None
    assert text_job.payload["bulk_id"] == bulk_id


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
            .where(BackgroundJob.job_type.in_(LLM_JOB_TYPES))
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
            .where(BackgroundJob.job_type.in_(LLM_JOB_TYPES))
        )
        == 0
    )


class FakeOllama:
    def __init__(self, content, *, on_chat=None):
        self.content = content
        self.calls = []
        self.on_chat = on_chat

    def chat(self, *, messages, output_schema):
        if self.on_chat is not None:
            self.on_chat()
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
    commits = 0
    original_commit = db.commit

    def tracked_commit():
        nonlocal commits
        original_commit()
        commits += 1

    monkeypatch.setattr(db, "commit", tracked_commit)

    def assert_processing_was_committed():
        assert commits == 1

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
        },
        on_chat=assert_processing_was_committed,
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


def test_structured_response_coerces_stray_value_on_not_applicable_status(
    db,
) -> None:
    *_, schema, sample, method = setup_llm_project(db)[0:8]
    fields = schema.fields
    payload = {
        "fields": {
            sample.stable_key: {
                "value": False,
                "status": "not_applicable",
                "evidence": [],
            },
            method.stable_key: {
                "value": "n/a",
                "status": "not_found",
                "evidence": [],
            },
        }
    }
    result = validate_result(payload, fields)
    assert result.fields[sample.stable_key].value is None
    assert result.fields[method.stable_key].value is None


def test_structured_response_reclassifies_not_found_with_evidence_as_ambiguous(
    db,
) -> None:
    *_, schema, sample, method = setup_llm_project(db)[0:8]
    fields = schema.fields
    payload = {
        "fields": {
            sample.stable_key: {
                "value": 24,
                "status": "not_found",
                "evidence": [
                    {
                        "page": 2,
                        "quote": "Twenty-four participants took part in the study.",
                    }
                ],
            },
            method.stable_key: {
                "value": "experiment",
                "status": "explicit",
                "evidence": [],
            },
        }
    }
    result = validate_result(payload, fields)
    field_result = result.fields[sample.stable_key]
    assert field_result.value == 24
    assert field_result.status == "ambiguous"
    assert len(field_result.evidence) == 1


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
    messages = extraction_messages(schema.fields, [], chunks[0])
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
    assert db.get(LlmExtractionRun, run.id).status == ProcessingStatus.PROCESSING


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


def test_administrator_can_override_installation_llm_settings(client, db) -> None:
    admin, reviewer, project, _, _, _, _, _ = setup_llm_project(db)
    reviewer_membership = db.scalar(
        select(ProjectMembership).where(
            ProjectMembership.project_id == project.id,
            ProjectMembership.user_id == reviewer.id,
        )
    )
    assert reviewer_membership is not None
    reviewer_membership.is_owner = True
    db.commit()
    anonymous_get = client.get("/api/v1/llm/installation-settings")
    assert anonymous_get.status_code == 403

    admin_csrf = client.post(
        "/api/v1/auth/login",
        json={"username": admin.username, "password": "secret-password"},
    ).json()["csrfToken"]

    updated = client.patch(
        "/api/v1/llm/installation-settings",
        json={
            "enabled": True,
            "endpoint": "https://ollama.internal.example:11434/",
            "model": "gemma3:12b",
            "contextLength": 16384,
            "apiKey": "secret-key",
            "requestTimeoutSeconds": 120,
            "maxConcurrentJobs": 2,
            "maxEvidenceItems": 5,
            "maxEvidenceQuoteChars": 800,
        },
        headers={"X-CSRF-Token": admin_csrf},
    )
    assert updated.status_code == 200
    assert updated.json() == {
        "enabled": True,
        "provider": "Ollama",
        "endpoint": "https://ollama.internal.example:11434",
        "model": "gemma3:12b",
        "contextLength": 16384,
        "apiKeySet": True,
        "requestTimeoutSeconds": 120,
        "maxConcurrentJobs": 2,
        "maxEvidenceItems": 5,
        "maxEvidenceQuoteChars": 800,
    }

    admin_view = client.get("/api/v1/llm/installation-settings")
    assert admin_view.status_code == 200
    assert admin_view.json() == {
        "enabled": True,
        "provider": "Ollama",
        "endpoint": "https://ollama.internal.example:11434",
        "model": "gemma3:12b",
        "contextLength": 16384,
        "apiKeySet": True,
        "requestTimeoutSeconds": 120,
        "maxConcurrentJobs": 2,
        "maxEvidenceItems": 5,
        "maxEvidenceQuoteChars": 800,
    }

    project_view = client.get(f"/api/v1/projects/{project.id}/llm/settings")
    assert project_view.json()["model"] == "gemma3:12b"
    assert "endpoint" not in project_view.json()
    assert "canManageInstallation" not in project_view.json()

    client.post("/api/v1/auth/logout", headers={"X-CSRF-Token": admin_csrf})
    owner_csrf = client.post(
        "/api/v1/auth/login",
        json={"username": reviewer.username, "password": "reviewer-password"},
    ).json()["csrfToken"]
    owner_view = client.get(f"/api/v1/projects/{project.id}/llm/settings")
    assert owner_view.status_code == 200
    assert "endpoint" not in owner_view.json()
    assert owner_view.json()["model"] == "gemma3:12b"

    forbidden = client.patch(
        "/api/v1/llm/installation-settings",
        json={
            "enabled": False,
            "endpoint": "https://other.example",
            "model": "other-model",
            "contextLength": 8192,
            "requestTimeoutSeconds": 300,
            "maxConcurrentJobs": 1,
            "maxEvidenceItems": 3,
            "maxEvidenceQuoteChars": 500,
        },
        headers={"X-CSRF-Token": owner_csrf},
    )
    assert forbidden.status_code == 403

    forbidden_get_by_owner = client.get("/api/v1/llm/installation-settings")
    assert forbidden_get_by_owner.status_code == 403


def test_administrator_can_test_installation_connection(
    client, db, monkeypatch
) -> None:
    admin, reviewer, project, _, _, _, _, _ = setup_llm_project(db)
    admin_csrf = client.post(
        "/api/v1/auth/login",
        json={"username": admin.username, "password": "secret-password"},
    ).json()["csrfToken"]

    class ConnectionClient:
        def test_connection(self):
            return {"available": True, "modelAvailable": True, "model": "test-model"}

    monkeypatch.setattr(
        "app.llm.routes.create_ollama_client", lambda: ConnectionClient()
    )
    tested = client.post(
        "/api/v1/llm/installation-settings/test",
        headers={"X-CSRF-Token": admin_csrf},
    )
    assert tested.status_code == 200
    assert tested.json()["modelAvailable"] is True

    client.post("/api/v1/auth/logout", headers={"X-CSRF-Token": admin_csrf})
    reviewer_csrf = client.post(
        "/api/v1/auth/login",
        json={"username": reviewer.username, "password": "reviewer-password"},
    ).json()["csrfToken"]
    forbidden = client.post(
        "/api/v1/llm/installation-settings/test",
        headers={"X-CSRF-Token": reviewer_csrf},
    )
    assert forbidden.status_code == 403


def test_administrator_can_override_and_reset_base_prompts(client, db) -> None:
    from app.llm.prompt import SYSTEM_PROMPT
    from app.llm.task_prompt import SCREENING_SYSTEM_PROMPT, VALIDATION_SYSTEM_PROMPT

    admin, reviewer, project, _, _, _, _, _ = setup_llm_project(db)

    anonymous_get = client.get("/api/v1/llm/installation-settings/prompts")
    assert anonymous_get.status_code == 403

    admin_csrf = client.post(
        "/api/v1/auth/login",
        json={"username": admin.username, "password": "secret-password"},
    ).json()["csrfToken"]

    default_flows = client.get("/api/v1/llm/installation-settings/prompts")
    assert default_flows.status_code == 200
    by_key = {flow["key"]: flow for flow in default_flows.json()["flows"]}
    assert set(by_key) == {"titleAbstract", "fullText", "extraction", "validation"}
    assert by_key["titleAbstract"]["defaultPrompt"] == SCREENING_SYSTEM_PROMPT
    assert by_key["titleAbstract"]["currentPrompt"] == SCREENING_SYSTEM_PROMPT
    assert by_key["titleAbstract"]["isOverridden"] is False
    assert by_key["extraction"]["defaultPrompt"] == SYSTEM_PROMPT
    assert by_key["validation"]["defaultPrompt"] == VALIDATION_SYSTEM_PROMPT

    updated = client.put(
        "/api/v1/llm/installation-settings/prompts",
        json={"titleAbstractPrompt": "Custom screening instructions."},
        headers={"X-CSRF-Token": admin_csrf},
    )
    assert updated.status_code == 200
    updated_by_key = {flow["key"]: flow for flow in updated.json()["flows"]}
    assert (
        updated_by_key["titleAbstract"]["currentPrompt"]
        == "Custom screening instructions."
    )
    assert updated_by_key["titleAbstract"]["isOverridden"] is True
    # Untouched flows stay at their defaults.
    assert updated_by_key["fullText"]["isOverridden"] is False
    assert updated_by_key["fullText"]["currentPrompt"] == SCREENING_SYSTEM_PROMPT

    # The override is reflected back to project owners for reference.
    project_prompts = client.get(
        f"/api/v1/projects/{project.id}/prompt-settings",
        headers={"X-CSRF-Token": admin_csrf},
    )
    project_flow = next(
        flow
        for flow in project_prompts.json()["flows"]
        if flow["key"] == "titleAbstract"
    )
    assert project_flow["basePrompt"] == "Custom screening instructions."

    reset = client.put(
        "/api/v1/llm/installation-settings/prompts",
        json={"titleAbstractPrompt": ""},
        headers={"X-CSRF-Token": admin_csrf},
    )
    assert reset.status_code == 200
    reset_by_key = {flow["key"]: flow for flow in reset.json()["flows"]}
    assert reset_by_key["titleAbstract"]["isOverridden"] is False
    assert reset_by_key["titleAbstract"]["currentPrompt"] == SCREENING_SYSTEM_PROMPT

    client.post("/api/v1/auth/logout", headers={"X-CSRF-Token": admin_csrf})
    reviewer_membership = db.scalar(
        select(ProjectMembership).where(
            ProjectMembership.project_id == project.id,
            ProjectMembership.user_id == reviewer.id,
        )
    )
    reviewer_membership.is_owner = True
    db.commit()
    owner_csrf = client.post(
        "/api/v1/auth/login",
        json={"username": reviewer.username, "password": "reviewer-password"},
    ).json()["csrfToken"]
    forbidden_get = client.get("/api/v1/llm/installation-settings/prompts")
    assert forbidden_get.status_code == 403
    forbidden_put = client.put(
        "/api/v1/llm/installation-settings/prompts",
        json={"extractionPrompt": "Should not be allowed."},
        headers={"X-CSRF-Token": owner_csrf},
    )
    assert forbidden_put.status_code == 403


def test_disabling_installation_cancels_all_queued_llm_work(client, db) -> None:
    admin, _, project, publication, _, _, _, _ = setup_llm_project(db)
    include_title_abstract(db, publication)
    csrf = client.post(
        "/api/v1/auth/login",
        json={"username": admin.username, "password": "secret-password"},
    ).json()["csrfToken"]

    enable = client.patch(
        f"/api/v1/projects/{project.id}/llm/settings",
        json={"titleAbstractScreeningEnabled": True},
        headers={"X-CSRF-Token": csrf},
    )
    assert enable.status_code == 200
    run = db.scalar(
        select(LlmExtractionRun).where(
            LlmExtractionRun.publication_id == publication.id,
            LlmExtractionRun.task_type == LlmTaskType.TITLE_ABSTRACT_SCREENING,
        )
    )
    assert run is not None
    assert run.status == ProcessingStatus.PENDING
    job = db.get(BackgroundJob, run.background_job_id)
    assert job is not None
    assert job.status == JobStatus.QUEUED

    narrative_job = enqueue_job(
        db,
        STAGE_ANALYSIS_JOB,
        {"stage": "extraction_quality"},
        project_id=project.id,
        created_by_id=admin.id,
        priority=5,
    )
    db.commit()

    disable = client.patch(
        "/api/v1/llm/installation-settings",
        json={
            "enabled": False,
            "endpoint": "https://ollama.internal.example:11434",
            "model": "gemma3:12b",
            "contextLength": 16384,
            "requestTimeoutSeconds": 300,
            "maxConcurrentJobs": 1,
            "maxEvidenceItems": 3,
            "maxEvidenceQuoteChars": 500,
        },
        headers={"X-CSRF-Token": csrf},
    )
    assert disable.status_code == 200
    db.refresh(run)
    db.refresh(job)
    db.refresh(narrative_job)
    assert run.status == ProcessingStatus.CANCELLED
    assert job.status == JobStatus.CANCELLED
    assert narrative_job.status == JobStatus.CANCELLED


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
    inference = BackgroundJob(
        job_type=LLM_JOB_DATA_EXTRACTION, payload={"run_id": "run"}
    )
    db.add_all([generic, inference])
    db.commit()
    claimed_generic = claim_job(db, "normal", excluded_job_types=LLM_JOB_TYPES)
    assert claimed_generic.id == generic.id
    db.commit()
    claimed_llm = claim_job(db, "gpu", allowed_job_types=LLM_JOB_TYPES)
    assert claimed_llm.id == inference.id


def test_dedicated_worker_recovers_an_expired_llm_lease(db) -> None:
    job = BackgroundJob(
        job_type=LLM_JOB_DATA_EXTRACTION,
        payload={"run_id": "run"},
        status=JobStatus.RUNNING,
        attempts=1,
        max_attempts=3,
        locked_by="dead-worker",
        lease_until=datetime.now(UTC) - timedelta(seconds=1),
    )
    db.add(job)
    db.commit()
    recovered = claim_job(db, "replacement-worker", allowed_job_types=LLM_JOB_TYPES)
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
    commits = 0
    original_commit = db.commit

    def tracked_commit():
        nonlocal commits
        original_commit()
        commits += 1

    monkeypatch.setattr(db, "commit", tracked_commit)

    def assert_processing_was_committed():
        assert commits == 1

    fake = FakeOllama(
        {
            "suggested_decision": "exclude",
            "confidence": "high",
            "criteria": {
                criterion.id: {
                    "assessment": "unclear",
                    "explanation": "The abstract does not describe the evaluation.",
                    "evidence": [],
                }
            },
            "reasoning_summary": "The available metadata is insufficient.",
        },
        on_chat=assert_processing_was_committed,
    )
    monkeypatch.setattr("app.llm.task_execution.create_ollama_client", lambda: fake)
    job = db.get(BackgroundJob, run.background_job_id)
    run_llm_task_job(db, job)
    db.commit()
    db.refresh(run)
    assert run.raw_result["suggested_decision"] == "uncertain"
    assert run.raw_result["confidence"] == "low"

    # Legacy runs may contain a model-reported overall result that predates
    # server-side derivation. The response must still use the criteria.
    run.raw_result = {
        **run.raw_result,
        "suggested_decision": "exclude",
        "confidence": "high",
        "reasoning_summary": "Legacy contradictory result",
    }
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
    assert revealed.json()["confidence"] == "low"
    assert "criteria are unclear" in revealed.json()["reasoningSummary"]
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


def test_reviewer_never_sees_suggestion_after_capability_disabled(
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
        random_rank="title-llm-disable",
    )
    db.add(item)
    db.commit()

    run = queue_title_abstract_suggestion(db, publication.id)
    assert run is not None
    fake = FakeOllama(
        {
            "suggested_decision": "include",
            "confidence": "high",
            "criteria": {
                criterion.id: {
                    "assessment": "met",
                    "explanation": "The abstract reports an evaluation.",
                    "evidence": [],
                }
            },
            "reasoning_summary": "Looks relevant.",
        }
    )
    monkeypatch.setattr("app.llm.task_execution.create_ollama_client", lambda: fake)
    job = db.get(BackgroundJob, run.background_job_id)
    run_llm_task_job(db, job)
    db.commit()
    db.refresh(run)
    assert run.status == ProcessingStatus.COMPLETED

    submit_decision(db, item, reviewer.id, "include", {criterion.id: True}, None)
    db.commit()

    csrf = client.post(
        "/api/v1/auth/login",
        json={"username": reviewer.username, "password": "reviewer-password"},
    ).json()["csrfToken"]
    path = f"/api/v1/projects/{project.id}/screening/work-items/{item.id}/llm-title-abstract"
    revealed = client.get(path)
    assert revealed.status_code == 200
    assert revealed.json()["state"] == "ready"

    # Disabling the capability must hide even an already-completed run.
    settings.title_abstract_screening_enabled = False
    db.commit()

    still_hidden = client.get(path, headers={"X-CSRF-Token": csrf})
    assert still_hidden.status_code == 200
    assert still_hidden.json()["state"] == "disabled"
    assert still_hidden.json()["suggestedDecision"] is None
    assert still_hidden.json()["criteria"] == []


def test_title_suggestion_reports_disabled_before_own_decision_is_submitted(
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
        random_rank="title-llm-disabled-before-decision",
    )
    db.add(item)
    db.commit()

    # Disable the capability before the reviewer has submitted their own
    # decision. The "hidden until you decide" placeholder must not appear —
    # there is nothing to hide, the feature is simply off.
    settings.title_abstract_screening_enabled = False
    db.commit()

    csrf = client.post(
        "/api/v1/auth/login",
        json={"username": reviewer.username, "password": "reviewer-password"},
    ).json()["csrfToken"]
    path = f"/api/v1/projects/{project.id}/screening/work-items/{item.id}/llm-title-abstract"
    response = client.get(path, headers={"X-CSRF-Token": csrf})
    assert response.status_code == 200
    assert response.json()["state"] == "disabled"
    assert "hidden" not in response.json() or response.json()["hidden"] is not True


def test_title_suggestion_is_queued_when_screening_work_item_becomes_eligible(
    db,
) -> None:
    _, reviewer, project, publication, _, _, _, _ = setup_llm_project(db)
    membership = db.scalar(
        select(ProjectMembership).where(
            ProjectMembership.project_id == project.id,
            ProjectMembership.user_id == reviewer.id,
        )
    )
    membership.can_title_abstract_screen = True
    settings = project_settings(db, project.id)
    assert settings is not None
    settings.title_abstract_screening_enabled = True
    db.add(
        ScreeningConfig(
            project_id=project.id,
            stage=ScreeningStage.TITLE_ABSTRACT,
            required_reviewers=1,
            allocation_mode=AllocationMode.DIVIDED,
        )
    )
    db.flush()

    assert create_screening_work_items(db, project, ScreeningStage.TITLE_ABSTRACT) == 1
    run = db.scalar(
        select(LlmExtractionRun).where(
            LlmExtractionRun.publication_id == publication.id,
            LlmExtractionRun.task_type == LlmTaskType.TITLE_ABSTRACT_SCREENING,
        )
    )
    assert run is not None
    job = db.get(BackgroundJob, run.background_job_id)
    assert job is not None
    assert job.status == JobStatus.QUEUED
    assert job.priority == 0

    # Re-running work-item creation is idempotent for both assignments and LLM work.
    assert create_screening_work_items(db, project, ScreeningStage.TITLE_ABSTRACT) == 0
    assert (
        db.scalar(
            select(func.count())
            .select_from(LlmExtractionRun)
            .where(
                LlmExtractionRun.publication_id == publication.id,
                LlmExtractionRun.task_type == LlmTaskType.TITLE_ABSTRACT_SCREENING,
            )
        )
        == 1
    )


def test_opening_title_screening_promotes_a_precomputed_queued_job(db) -> None:
    _, _, project, publication, _, _, _, _ = setup_llm_project(db)
    settings = project_settings(db, project.id)
    assert settings is not None
    settings.title_abstract_screening_enabled = True

    run = queue_title_abstract_suggestion(db, publication.id, priority=-10)
    assert run is not None
    job = db.get(BackgroundJob, run.background_job_id)
    assert job is not None
    assert job.priority == -10

    same_run = queue_title_abstract_suggestion(db, publication.id, priority=10)
    assert same_run is run
    assert job.priority == 10


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
    include_full_text(db, publication)
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


def test_validation_cohort_waits_until_every_human_extraction_is_complete(db) -> None:
    _, reviewer, project, publication, _, _, sample, method = setup_llm_project(db)
    settings = project_settings(db, project.id)
    assert settings is not None
    settings.extraction_validation_enabled = True
    include_title_abstract(db, publication)
    include_full_text(db, publication)
    text_job = db.scalar(
        select(BackgroundJob).where(BackgroundJob.job_type == TEXT_JOB)
    )
    assert text_job is not None
    extract_document_text_job(db, text_job)

    second_publication = Publication(project_id=project.id, title="Second paper")
    db.add(second_publication)
    db.flush()
    include_full_text(db, second_publication)
    first_item = ExtractionWorkItem(
        project_id=project.id,
        publication_id=publication.id,
        assigned_reviewer_id=reviewer.id,
        random_rank="validation-1",
    )
    second_item = ExtractionWorkItem(
        project_id=project.id,
        publication_id=second_publication.id,
        assigned_reviewer_id=reviewer.id,
        random_rank="validation-2",
    )
    db.add_all([first_item, second_item])
    db.flush()

    answers = {sample.stable_key: 22, method.stable_key: "experiment"}
    submit_extraction(db, first_item, reviewer.id, answers)
    assert (
        db.scalar(
            select(func.count())
            .select_from(LlmExtractionRun)
            .where(LlmExtractionRun.task_type == LlmTaskType.EXTRACTION_VALIDATION)
        )
        == 0
    )

    submit_extraction(db, second_item, reviewer.id, answers)
    validation_runs = list(
        db.scalars(
            select(LlmExtractionRun).where(
                LlmExtractionRun.task_type == LlmTaskType.EXTRACTION_VALIDATION
            )
        )
    )
    assert len(validation_runs) == 1
    assert validation_runs[0].publication_id == publication.id


def test_validation_review_lists_assigned_mismatches_and_supports_revision(
    client, db
) -> None:
    _, reviewer, project, publication, document, _, sample, method = setup_llm_project(
        db
    )
    settings = project_settings(db, project.id)
    assert settings is not None
    settings.extraction_validation_enabled = True
    item = ExtractionWorkItem(
        project_id=project.id,
        publication_id=publication.id,
        assigned_reviewer_id=reviewer.id,
        random_rank="validation-review",
    )
    db.add(item)
    db.flush()
    response = submit_extraction(
        db,
        item,
        reviewer.id,
        {sample.stable_key: 22, method.stable_key: "experiment"},
    )
    from app.extraction.final import get_current_final_extraction

    final = get_current_final_extraction(db, publication.id)
    assert final is not None
    run = LlmExtractionRun(
        project_id=project.id,
        publication_id=publication.id,
        task_type=LlmTaskType.EXTRACTION_VALIDATION,
        input_fingerprint="review-fingerprint",
        document_id=document.id,
        extraction_response_id=response.id,
        final_extraction_id=final.id,
        provider="ollama",
        model="test-model:latest",
        model_configuration={"temperature": 0},
        prompt_template_version="extraction_validation_v1",
        status=ProcessingStatus.COMPLETED,
        queued_at=datetime.now(UTC),
        completed_at=datetime.now(UTC),
    )
    db.add(run)
    db.flush()
    db.add(
        LlmValidationResult(
            run_id=run.id,
            extraction_field_key=sample.stable_key,
            field_label="Sample size",
            value_snapshot=22,
            assessment="contradicted",
            explanation="The paper reports 24 participants.",
            evidence=[],
            evidence_validation_status=EvidenceStatus.UNVERIFIED,
        )
    )
    outsider = create_user(db, "llm-outsider", "Outsider", "outsider-password")
    db.commit()

    login = client.post(
        "/api/v1/auth/login",
        json={"username": reviewer.username, "password": "reviewer-password"},
    )
    assert login.status_code == 200
    review = client.get(
        f"/api/v1/projects/{project.id}/llm/extraction-validation-review"
    )
    assert review.status_code == 200
    body = review.json()
    assert body["enabled"] is True
    assert body["items"][0]["workItemId"] == item.id
    assert body["items"][0]["submittedAt"] is not None
    assert body["items"][0]["publication"]["venue"] == publication.venue
    assert body["items"][0]["publication"]["doi"] == publication.doi
    assert body["items"][0]["results"][0]["assessment"] == "contradicted"

    revision = client.get(f"/api/v1/projects/{project.id}/extraction/{item.id}")
    assert revision.status_code == 200
    assert revision.json()["draft"][sample.stable_key] == 22
    assert revision.json()["currentResponse"]["id"] == response.id

    client.post(
        "/api/v1/auth/logout", headers={"X-CSRF-Token": login.json()["csrfToken"]}
    )
    outsider_login = client.post(
        "/api/v1/auth/login",
        json={"username": outsider.username, "password": "outsider-password"},
    )
    assert outsider_login.status_code == 200
    forbidden = client.get(
        f"/api/v1/projects/{project.id}/llm/extraction-validation-review"
    )
    assert forbidden.status_code == 403


def test_validation_waits_for_dual_extraction_consensus_then_targets_it(db) -> None:
    """Dual-extraction mode: extraction validation must never queue against
    an individual, still-unresolved response -- only once both independent
    slots agree (or are reconciled) into an authoritative FinalExtraction."""
    from app.extraction.final import get_current_final_extraction
    from app.extraction.models import ExtractionConfig
    from app.extraction.service import claim_next_extraction, initialize_extraction
    from app.llm.task_service import (
        project_extractions_completed,
        queue_extraction_validation,
    )
    from app.projects.models import ProjectMembership as PM

    (
        admin,
        reviewer,
        project,
        publication,
        document,
        _schema,
        sample,
        method,
    ) = setup_llm_project(db)
    settings = project_settings(db, project.id)
    assert settings is not None
    settings.extraction_validation_enabled = True
    second_reviewer = create_user(db, "llm-reviewer-2", "Reviewer 2", "long-password-2")
    db.add(PM(project_id=project.id, user_id=second_reviewer.id, can_extract=True))
    db.add(ExtractionConfig(project_id=project.id, required_reviewers=2))
    include_title_abstract(db, publication)
    include_full_text(db, publication)
    text_job = db.scalar(
        select(BackgroundJob).where(BackgroundJob.job_type == TEXT_JOB)
    )
    extract_document_text_job(db, text_job)
    db.commit()
    initialize_extraction(db, project)
    db.commit()

    item_a = claim_next_extraction(db, project.id, reviewer.id)
    assert item_a is not None
    submit_extraction(
        db,
        item_a,
        reviewer.id,
        {sample.stable_key: 22, method.stable_key: "experiment"},
    )
    db.commit()

    # Only one of two required slots is done -- no authoritative result yet,
    # so validation must not be queueable.
    assert project_extractions_completed(db, project.id) is False
    assert queue_extraction_validation(db, publication.id) is None

    item_b = claim_next_extraction(db, project.id, second_reviewer.id)
    assert item_b is not None
    submit_extraction(
        db,
        item_b,
        second_reviewer.id,
        {sample.stable_key: 99, method.stable_key: "survey"},
    )
    db.commit()

    # Both slots are done but disagree -- still no authoritative result.
    assert project_extractions_completed(db, project.id) is False
    assert queue_extraction_validation(db, publication.id) is None

    from app.extraction.reconciliation import submit_reconciliation

    submit_reconciliation(
        db,
        publication.id,
        admin.id,
        {
            sample.stable_key: {"choice": "response_a"},
            method.stable_key: {"choice": "response_a"},
        },
        "Resolved via source PDF",
    )
    db.commit()

    final = get_current_final_extraction(db, publication.id)
    assert final is not None
    assert project_extractions_completed(db, project.id) is True

    run = queue_extraction_validation(db, publication.id)
    assert run is not None
    assert getattr(run, "final_extraction_id", None) == final.id


def test_analysis_narrative_enabled_defaults_true_and_can_be_toggled(
    client, db
) -> None:
    admin, _, project, _, _, _, _, _ = setup_llm_project(db)
    csrf = client.post(
        "/api/v1/auth/login",
        json={"username": admin.username, "password": "secret-password"},
    ).json()["csrfToken"]

    settings_response = client.get(f"/api/v1/projects/{project.id}/llm/settings")
    assert settings_response.status_code == 200
    assert settings_response.json()["analysisNarrativeEnabled"] is True

    disabled = client.patch(
        f"/api/v1/projects/{project.id}/llm/settings",
        json={"analysisNarrativeEnabled": False},
        headers={"X-CSRF-Token": csrf},
    )
    assert disabled.status_code == 200
    assert disabled.json()["analysisNarrativeEnabled"] is False

    settings_response = client.get(f"/api/v1/projects/{project.id}/llm/settings")
    assert settings_response.json()["analysisNarrativeEnabled"] is False


def test_disabling_capability_cancels_queued_run_and_job(client, db) -> None:
    admin, _, project, publication, _, _, _, _ = setup_llm_project(db)
    include_title_abstract(db, publication)
    csrf = client.post(
        "/api/v1/auth/login",
        json={"username": admin.username, "password": "secret-password"},
    ).json()["csrfToken"]

    enable = client.patch(
        f"/api/v1/projects/{project.id}/llm/settings",
        json={"titleAbstractScreeningEnabled": True},
        headers={"X-CSRF-Token": csrf},
    )
    assert enable.status_code == 200
    run = db.scalar(
        select(LlmExtractionRun).where(
            LlmExtractionRun.publication_id == publication.id,
            LlmExtractionRun.task_type == LlmTaskType.TITLE_ABSTRACT_SCREENING,
        )
    )
    assert run is not None
    assert run.status == ProcessingStatus.PENDING
    job = db.get(BackgroundJob, run.background_job_id)
    assert job is not None
    assert job.status == JobStatus.QUEUED

    disable = client.patch(
        f"/api/v1/projects/{project.id}/llm/settings",
        json={"titleAbstractScreeningEnabled": False},
        headers={"X-CSRF-Token": csrf},
    )
    assert disable.status_code == 200
    db.refresh(run)
    db.refresh(job)
    assert run.status == ProcessingStatus.CANCELLED
    assert job.status == JobStatus.CANCELLED


def test_disabling_capability_discards_an_in_flight_result(db, monkeypatch) -> None:
    _, _, publication, document, schema, sample, method, run, job = prepared_run(db)

    def cancel_mid_flight() -> None:
        # Simulates a concurrent settings PATCH disabling the capability
        # while this job is mid Ollama-call: the run can't be interrupted,
        # but its result must never be persisted or shown.
        cancel_task_type_jobs(db, run.project_id, LlmTaskType.DATA_EXTRACTION)
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
        },
        on_chat=cancel_mid_flight,
    )
    monkeypatch.setattr("app.llm.extraction.create_ollama_client", lambda: fake)
    result = run_llm_extraction_job(db, job)
    db.commit()
    db.refresh(run)
    assert result["status"] == "cancelled"
    assert run.status == ProcessingStatus.CANCELLED
    assert run.raw_result is None
    assert (
        db.scalar(
            select(func.count())
            .select_from(LlmFieldSuggestion)
            .where(LlmFieldSuggestion.run_id == run.id)
        )
        == 0
    )


def test_enabling_capability_backfills_unscreened_publications_first(
    client, db
) -> None:
    admin, _, project, publication, _, _, _, _ = setup_llm_project(db)
    include_title_abstract(db, publication)
    unscreened = Publication(project_id=project.id, title="Second paper")
    db.add(unscreened)
    db.commit()

    csrf = client.post(
        "/api/v1/auth/login",
        json={"username": admin.username, "password": "secret-password"},
    ).json()["csrfToken"]
    response = client.patch(
        f"/api/v1/projects/{project.id}/llm/settings",
        json={"titleAbstractScreeningEnabled": True},
        headers={"X-CSRF-Token": csrf},
    )
    assert response.status_code == 200

    screened_run = db.scalar(
        select(LlmExtractionRun).where(
            LlmExtractionRun.publication_id == publication.id,
            LlmExtractionRun.task_type == LlmTaskType.TITLE_ABSTRACT_SCREENING,
        )
    )
    unscreened_run = db.scalar(
        select(LlmExtractionRun).where(
            LlmExtractionRun.publication_id == unscreened.id,
            LlmExtractionRun.task_type == LlmTaskType.TITLE_ABSTRACT_SCREENING,
        )
    )
    assert screened_run is not None
    assert unscreened_run is not None
    screened_job = db.get(BackgroundJob, screened_run.background_job_id)
    unscreened_job = db.get(BackgroundJob, unscreened_run.background_job_id)
    assert screened_job.priority == -10
    assert unscreened_job.priority == 0


def test_reanalyze_rejects_disabled_task_type(client, db) -> None:
    admin, _, project, publication, _, _, _, _ = setup_llm_project(db)
    include_title_abstract(db, publication)
    csrf = client.post(
        "/api/v1/auth/login",
        json={"username": admin.username, "password": "secret-password"},
    ).json()["csrfToken"]

    response = client.post(
        f"/api/v1/projects/{project.id}/llm/runs/reanalyze",
        json={"taskType": "full_text_screening"},
        headers={"X-CSRF-Token": csrf},
    )
    assert response.status_code == 400


def test_reanalyze_full_text_screening_targets_included_not_excluded_publications(
    client, db
) -> None:
    admin, _, project, publication, _, _, _, _ = setup_llm_project(db)
    include_title_abstract(db, publication)
    text_job = db.scalar(
        select(BackgroundJob).where(BackgroundJob.job_type == TEXT_JOB)
    )
    extract_document_text_job(db, text_job)
    db.commit()

    excluded = Publication(project_id=project.id, title="Excluded paper")
    db.add(excluded)
    db.commit()
    record_final_decision(
        db,
        excluded.id,
        ScreeningStage.TITLE_ABSTRACT,
        "include",
        "agreement",
        None,
        None,
    )
    record_final_decision(
        db, excluded.id, ScreeningStage.FULL_TEXT, "exclude", "agreement", None, None
    )
    db.commit()

    settings = project_settings(db, project.id)
    settings.full_text_screening_enabled = True
    db.commit()
    csrf = client.post(
        "/api/v1/auth/login",
        json={"username": admin.username, "password": "secret-password"},
    ).json()["csrfToken"]

    response = client.post(
        f"/api/v1/projects/{project.id}/llm/runs/reanalyze",
        json={"taskType": "full_text_screening"},
        headers={"X-CSRF-Token": csrf},
    )
    assert response.status_code == 200
    assert response.json()["queued"] == 1
    run = db.scalar(
        select(LlmExtractionRun).where(
            LlmExtractionRun.task_type == LlmTaskType.FULL_TEXT_SCREENING
        )
    )
    assert run is not None
    assert run.publication_id == publication.id


def test_reanalyze_extraction_validation_requires_completed_cohort(client, db) -> None:
    admin, _, project, publication, _, _, _, _ = setup_llm_project(db)
    settings = project_settings(db, project.id)
    settings.extraction_validation_enabled = True
    db.commit()
    csrf = client.post(
        "/api/v1/auth/login",
        json={"username": admin.username, "password": "secret-password"},
    ).json()["csrfToken"]

    response = client.post(
        f"/api/v1/projects/{project.id}/llm/runs/reanalyze",
        json={"taskType": "extraction_validation"},
        headers={"X-CSRF-Token": csrf},
    )
    assert response.status_code == 400
