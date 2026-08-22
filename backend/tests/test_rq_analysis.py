from __future__ import annotations

from sqlalchemy import select

from app.accounts.service import create_user
from app.analysis.models import ResearchQuestionAnalysisRun
from app.analysis.rq_jobs import (
    RQ_SYNTHESIS_JOB,
    cancel_queued_rq_synthesis_jobs,
    compute_rq_fingerprint,
    generate_rq_synthesis_job,
    latest_successful_run,
    queue_rq_synthesis,
    run_history,
)
from app.core.config import get_settings
from app.extraction.models import ExtractionWorkItem
from app.extraction.service import submit_extraction
from app.forms.service import rename_field
from app.jobs.models import BackgroundJob, JobStatus
from app.jobs.registry import LLM_JOB_TYPES
from app.llm.ollama import OllamaResponse, OllamaResponseError
from app.llm.rq_chunking import chunk_facts
from app.llm.rq_sources import SourceEntry, assign_source_ids, validate_source_ids
from app.llm.rq_synthesis import run_rq_synthesis
from app.projects.models import Project, ResearchQuestion, ReviewType
from app.quality.models import QualityWorkItem
from app.quality.service import submit_quality
from app.reporting.evidence_dataset import EvidenceFact, build_evidence_dataset
from tests.test_evidence_matrix import setup_matrix_project

_EMPTY_METRICS = {
    "total_duration": None,
    "load_duration": None,
    "prompt_eval_count": None,
    "prompt_eval_duration": None,
    "eval_count": None,
    "eval_duration": None,
}


class FakeOllama:
    """Returns queued canned responses in order, one per ``.chat()`` call."""

    def __init__(self, responses):
        self._responses = list(responses)
        self.calls: list[list[dict[str, str]]] = []

    def chat(self, *, messages, output_schema):
        self.calls.append(messages)
        content = (
            self._responses.pop(0)
            if self._responses
            else {
                "statements": [],
                "limitations": [],
            }
        )
        return OllamaResponse(content=content, metrics=dict(_EMPTY_METRICS))


def _add_research_question(db, project, text="What study designs were used?"):
    rq = ResearchQuestion(project_id=project.id, text=text, position=0)
    db.add(rq)
    db.commit()
    return rq


def login(client, username: str, password: str) -> str:
    response = client.post(
        "/api/v1/auth/login", json={"username": username, "password": password}
    )
    assert response.status_code == 200
    return response.json()["csrfToken"]


def _enable_installation_llm(monkeypatch) -> None:
    settings = get_settings()
    monkeypatch.setattr(settings, "llm_enabled", True)
    monkeypatch.setattr(settings, "ollama_base_url", "http://ollama.example:11434")
    monkeypatch.setattr(settings, "ollama_model", "test-model:latest")
    monkeypatch.setattr(settings, "llm_context_length", 8192)


# ---------------------------------------------------------------------------
# rq_sources: deterministic assignment + silent-discard validation
# ---------------------------------------------------------------------------


def test_assign_source_ids_is_deterministic_stable_order_and_answered_only(db):
    project, *_ = setup_matrix_project(db)
    dataset = build_evidence_dataset(db, project.id)
    entries = assign_source_ids(dataset)

    assert entries, "matrix fixture has answered facts to cite"
    assert all(entry.fact.state == "answered" for entry in entries)
    ids = [entry.id for entry in entries]
    assert ids == [f"SRC-{index + 1:04d}" for index in range(len(ids))]

    entries_again = assign_source_ids(build_evidence_dataset(db, project.id))
    assert [entry.id for entry in entries_again] == ids


def test_validate_source_ids_silently_discards_unknown_ids_never_raises():
    known = {"SRC-0001", "SRC-0002"}
    assert validate_source_ids(["SRC-0001", "SRC-9999", "SRC-0002"], known) == [
        "SRC-0001",
        "SRC-0002",
    ]
    assert validate_source_ids(["SRC-9999"], known) == []
    assert validate_source_ids([], known) == []


# ---------------------------------------------------------------------------
# rq_chunking: never drops a fact
# ---------------------------------------------------------------------------


def _entry(index: int, value: str) -> SourceEntry:
    fact = EvidenceFact(
        publication_id="pub",
        source_type="extraction",
        field_key="k",
        label="Label",
        field_type="short_text",
        value=value,
        state="answered",
        resolution_method="single_reviewer",
        resolved_at=None,
        resolved_by_id=None,
        version_ref="v",
    )
    return SourceEntry(f"SRC-{index:04d}", fact, f"Publication {index}")


def test_chunk_facts_never_drops_an_entry_under_a_tight_budget():
    entries = [_entry(index, "x" * 50) for index in range(1, 21)]
    chunks = chunk_facts(entries, budget_tokens=1)
    flattened = [entry for chunk in chunks for entry in chunk]
    assert [entry.id for entry in flattened] == [entry.id for entry in entries]
    assert len(chunks) > 1


def test_chunk_facts_single_chunk_when_budget_is_generous():
    entries = [_entry(index, "x") for index in range(1, 6)]
    chunks = chunk_facts(entries, budget_tokens=100_000)
    assert len(chunks) == 1
    assert [entry.id for entry in chunks[0]] == [entry.id for entry in entries]


def test_chunk_facts_never_empty_for_empty_input():
    assert chunk_facts([], budget_tokens=100) == [[]]


# ---------------------------------------------------------------------------
# run_rq_synthesis orchestration
# ---------------------------------------------------------------------------


def test_run_rq_synthesis_single_chunk_skips_consolidation(db):
    project, *_ = setup_matrix_project(db)
    dataset = build_evidence_dataset(db, project.id)
    entries = assign_source_ids(dataset)
    source_id = entries[0].id
    fake = FakeOllama(
        [
            {
                "statements": [
                    {"claim": "RCT design was used.", "sourceIds": [source_id]}
                ],
                "limitations": ["Small sample"],
            }
        ]
    )

    result, _metrics = run_rq_synthesis(db, project.id, "What designs?", client=fake)

    assert len(fake.calls) == 1
    assert result["statements"] == [
        {"claim": "RCT design was used.", "sourceIds": [source_id]}
    ]
    assert result["limitations"] == ["Small sample"]
    assert (
        result["sourceRefs"][source_id]["publicationTitle"]
        == entries[0].publication_title
    )


def test_run_rq_synthesis_drops_statements_with_only_hallucinated_sources(db):
    project, *_ = setup_matrix_project(db)
    fake = FakeOllama(
        [
            {
                "statements": [{"claim": "Invented.", "sourceIds": ["SRC-9999"]}],
                "limitations": [],
            }
        ]
    )

    result, _ = run_rq_synthesis(db, project.id, "RQ", client=fake)

    assert result["statements"] == []
    assert result["sourceRefs"] == {}


def test_run_rq_synthesis_keeps_valid_and_drops_invalid_ids_from_mixed_statement(db):
    project, *_ = setup_matrix_project(db)
    dataset = build_evidence_dataset(db, project.id)
    valid_id = assign_source_ids(dataset)[0].id
    fake = FakeOllama(
        [
            {
                "statements": [
                    {"claim": "Mixed.", "sourceIds": [valid_id, "SRC-9999"]}
                ],
                "limitations": [],
            }
        ]
    )

    result, _ = run_rq_synthesis(db, project.id, "RQ", client=fake)

    assert result["statements"] == [{"claim": "Mixed.", "sourceIds": [valid_id]}]


def test_run_rq_synthesis_with_no_facts_short_circuits_without_calling_ollama(db):
    project = Project(
        name="Empty", review_type=ReviewType.SYSTEMATIC_REVIEW, random_seed="s"
    )
    db.add(project)
    db.commit()
    fake = FakeOllama([])

    result, _ = run_rq_synthesis(db, project.id, "RQ", client=fake)

    assert result["statements"] == []
    assert result["sourceRefs"] == {}
    assert fake.calls == []


def test_run_rq_synthesis_consolidates_and_revalidates_when_multiple_chunks(
    db, monkeypatch
):
    project, *_ = setup_matrix_project(db)
    dataset = build_evidence_dataset(db, project.id)
    entries = assign_source_ids(dataset)
    assert len(entries) >= 2
    half = len(entries) // 2

    def fake_chunk_facts(all_entries, _budget):
        return [all_entries[:half], all_entries[half:]]

    monkeypatch.setattr("app.llm.rq_synthesis.chunk_facts", fake_chunk_facts)
    id_a, id_b = entries[0].id, entries[-1].id
    fake = FakeOllama(
        [
            {
                "statements": [{"claim": "From chunk 1.", "sourceIds": [id_a]}],
                "limitations": [],
            },
            {
                "statements": [{"claim": "From chunk 2.", "sourceIds": [id_b]}],
                "limitations": [],
            },
            {
                "statements": [{"claim": "Consolidated.", "sourceIds": [id_a, id_b]}],
                "limitations": ["Overall limitation"],
            },
        ]
    )

    result, _ = run_rq_synthesis(db, project.id, "RQ", client=fake)

    assert len(fake.calls) == 3
    assert result["statements"] == [
        {"claim": "Consolidated.", "sourceIds": [id_a, id_b]}
    ]
    assert result["limitations"] == ["Overall limitation"]


# ---------------------------------------------------------------------------
# fingerprint staleness -- one distinct trigger per test
# ---------------------------------------------------------------------------


def test_fingerprint_changes_when_research_question_text_changes(db):
    project, *_ = setup_matrix_project(db)
    rq = _add_research_question(db, project)
    fp1 = compute_rq_fingerprint(db, project.id, rq)
    rq.text = "A completely different question"
    db.commit()
    fp2 = compute_rq_fingerprint(db, project.id, rq)
    assert fp1 != fp2


def test_fingerprint_changes_when_cohort_changes(db):
    from app.conflicts.service import record_final_decision
    from app.projects.models import ScreeningStage
    from app.publications.models import Publication

    project, *_ = setup_matrix_project(db)
    rq = _add_research_question(db, project)
    fp1 = compute_rq_fingerprint(db, project.id, rq)
    extra = Publication(project_id=project.id, title="New Paper")
    db.add(extra)
    db.flush()
    record_final_decision(
        db, extra.id, ScreeningStage.FULL_TEXT, "include", "agreement", None, None
    )
    db.commit()
    fp2 = compute_rq_fingerprint(db, project.id, rq)
    assert fp1 != fp2


def test_fingerprint_changes_when_extraction_value_changes(db):
    project, reviewer, fields, _quality_field, complete_pub, *_ = setup_matrix_project(
        db
    )
    rq = _add_research_question(db, project)
    fp1 = compute_rq_fingerprint(db, project.id, rq)
    item = db.scalar(
        select(ExtractionWorkItem).where(
            ExtractionWorkItem.publication_id == complete_pub.id
        )
    )
    submit_extraction(
        db,
        item,
        reviewer.id,
        {
            fields["design"].stable_key: "Cohort",
            fields["sample_size"].stable_key: 200,
            fields["themes"].stable_key: ["A"],
            fields["summary"].stable_key: "Revised summary.",
        },
    )
    db.commit()
    fp2 = compute_rq_fingerprint(db, project.id, rq)
    assert fp1 != fp2


def test_fingerprint_changes_when_quality_data_changes(db):
    project, reviewer, _fields, quality_field, complete_pub, *_ = setup_matrix_project(
        db
    )
    rq = _add_research_question(db, project)
    fp1 = compute_rq_fingerprint(db, project.id, rq)
    quality_item = db.scalar(
        select(QualityWorkItem).where(QualityWorkItem.publication_id == complete_pub.id)
    )
    submit_quality(db, quality_item, reviewer.id, {quality_field.stable_key: 1})
    db.commit()
    fp2 = compute_rq_fingerprint(db, project.id, rq)
    assert fp1 != fp2


def test_fingerprint_changes_when_form_metadata_changes(db):
    from app.extraction.service import project_form as extraction_project_form

    project, _reviewer, fields, *_ = setup_matrix_project(db)
    rq = _add_research_question(db, project)
    fp1 = compute_rq_fingerprint(db, project.id, rq)
    form = extraction_project_form(db, project.id)
    rename_field(db, form, fields["design"].stable_key, "Study Design (relabeled)")
    db.commit()
    fp2 = compute_rq_fingerprint(db, project.id, rq)
    assert fp1 != fp2


def test_fingerprint_changes_when_prompt_version_changes(db, monkeypatch):
    project, *_ = setup_matrix_project(db)
    rq = _add_research_question(db, project)
    fp1 = compute_rq_fingerprint(db, project.id, rq)
    monkeypatch.setattr(
        "app.analysis.rq_jobs.RQ_SYNTHESIS_PROMPT_VERSION", "rq_synthesis_v2"
    )
    fp2 = compute_rq_fingerprint(db, project.id, rq)
    assert fp1 != fp2


def test_fingerprint_changes_when_model_changes(db, monkeypatch):
    _enable_installation_llm(monkeypatch)
    project, *_ = setup_matrix_project(db)
    rq = _add_research_question(db, project)
    fp1 = compute_rq_fingerprint(db, project.id, rq)
    monkeypatch.setattr(get_settings(), "ollama_model", "different-model:latest")
    fp2 = compute_rq_fingerprint(db, project.id, rq)
    assert fp1 != fp2


# ---------------------------------------------------------------------------
# job handler
# ---------------------------------------------------------------------------


def test_job_handler_completes_and_persists_result(db, monkeypatch):
    _enable_installation_llm(monkeypatch)
    project, *_ = setup_matrix_project(db)
    rq = _add_research_question(db, project)
    dataset = build_evidence_dataset(db, project.id)
    source_id = assign_source_ids(dataset)[0].id
    fake = FakeOllama(
        [
            {
                "statements": [{"claim": "Finding.", "sourceIds": [source_id]}],
                "limitations": [],
            }
        ]
    )
    monkeypatch.setattr("app.llm.rq_synthesis.create_ollama_client", lambda: fake)

    run = queue_rq_synthesis(db, project.id, rq, created_by_id=None)
    db.commit()
    job = db.get(BackgroundJob, run.background_job_id)
    result = generate_rq_synthesis_job(db, job)
    db.commit()

    run = db.get(ResearchQuestionAnalysisRun, run.id)
    assert run.status == "completed"
    assert run.result["statements"] == [{"claim": "Finding.", "sourceIds": [source_id]}]
    assert source_id in run.validated_source_refs
    assert result["status"] == "completed"


def test_job_handler_marks_stale_when_data_changed_since_queued(db, monkeypatch):
    _enable_installation_llm(monkeypatch)
    project, reviewer, fields, _quality_field, complete_pub, *_ = setup_matrix_project(
        db
    )
    rq = _add_research_question(db, project)
    monkeypatch.setattr(
        "app.llm.rq_synthesis.create_ollama_client",
        lambda: FakeOllama([{"statements": [], "limitations": []}]),
    )
    run = queue_rq_synthesis(db, project.id, rq, created_by_id=None)
    db.commit()

    item = db.scalar(
        select(ExtractionWorkItem).where(
            ExtractionWorkItem.publication_id == complete_pub.id
        )
    )
    submit_extraction(
        db,
        item,
        reviewer.id,
        {
            fields["design"].stable_key: "Cohort",
            fields["sample_size"].stable_key: 200,
            fields["themes"].stable_key: ["A"],
            fields["summary"].stable_key: "Changed after queueing.",
        },
    )
    db.commit()

    job = db.get(BackgroundJob, run.background_job_id)
    result = generate_rq_synthesis_job(db, job)
    db.commit()

    run = db.get(ResearchQuestionAnalysisRun, run.id)
    assert run.status == "stale"
    assert result["status"] == "stale"


def test_job_handler_is_idempotent_for_already_completed_run(db, monkeypatch):
    _enable_installation_llm(monkeypatch)
    project, *_ = setup_matrix_project(db)
    rq = _add_research_question(db, project)
    fake = FakeOllama([{"statements": [], "limitations": []}])
    monkeypatch.setattr("app.llm.rq_synthesis.create_ollama_client", lambda: fake)

    run = queue_rq_synthesis(db, project.id, rq, created_by_id=None)
    db.commit()
    job = db.get(BackgroundJob, run.background_job_id)
    generate_rq_synthesis_job(db, job)
    db.commit()
    assert len(fake.calls) == 1

    second = generate_rq_synthesis_job(db, db.get(BackgroundJob, run.background_job_id))
    assert second["idempotent"] is True
    assert len(fake.calls) == 1


def test_failed_job_marks_run_failed_and_leaves_prior_success_intact(db, monkeypatch):
    _enable_installation_llm(monkeypatch)
    project, *_ = setup_matrix_project(db)
    rq = _add_research_question(db, project)
    dataset = build_evidence_dataset(db, project.id)
    source_id = assign_source_ids(dataset)[0].id

    monkeypatch.setattr(
        "app.llm.rq_synthesis.create_ollama_client",
        lambda: FakeOllama(
            [
                {
                    "statements": [{"claim": "Good.", "sourceIds": [source_id]}],
                    "limitations": [],
                }
            ]
        ),
    )
    run1 = queue_rq_synthesis(db, project.id, rq, created_by_id=None)
    db.commit()
    generate_rq_synthesis_job(db, db.get(BackgroundJob, run1.background_job_id))
    db.commit()

    rq.text = "A changed research question"
    db.commit()

    class Failing:
        def chat(self, **_kwargs):
            raise OllamaResponseError("bad output")

    monkeypatch.setattr("app.llm.rq_synthesis.create_ollama_client", lambda: Failing())
    run2 = queue_rq_synthesis(db, project.id, rq, created_by_id=None)
    db.commit()
    generate_rq_synthesis_job(db, db.get(BackgroundJob, run2.background_job_id))
    db.commit()

    run2 = db.get(ResearchQuestionAnalysisRun, run2.id)
    assert run2.status == "failed"
    assert run2.error

    latest_success = latest_successful_run(db, rq.id)
    assert latest_success.id == run1.id
    assert latest_success.result["statements"][0]["claim"] == "Good."

    history = run_history(db, rq.id)
    assert [item.id for item in history] == [run2.id, run1.id]


def test_cancel_queued_rq_synthesis_jobs_cancels_pending_run_and_job(db, monkeypatch):
    _enable_installation_llm(monkeypatch)
    project, *_ = setup_matrix_project(db)
    rq = _add_research_question(db, project)
    run = queue_rq_synthesis(db, project.id, rq, created_by_id=None)
    db.commit()

    cancelled = cancel_queued_rq_synthesis_jobs(db)
    db.commit()

    assert cancelled == 1
    job = db.get(BackgroundJob, run.background_job_id)
    assert job.status == JobStatus.CANCELLED
    run = db.get(ResearchQuestionAnalysisRun, run.id)
    assert run.status == "cancelled"


# ---------------------------------------------------------------------------
# job-type wiring
# ---------------------------------------------------------------------------


def test_rq_synthesis_job_is_in_llm_job_types():
    assert RQ_SYNTHESIS_JOB in LLM_JOB_TYPES


def test_rq_synthesis_job_has_its_own_worker_handler():
    from app.jobs.worker import HANDLERS

    assert HANDLERS[RQ_SYNTHESIS_JOB] is generate_rq_synthesis_job


# ---------------------------------------------------------------------------
# routes / permission
# ---------------------------------------------------------------------------


def test_analysis_route_requires_project_membership(client, db, monkeypatch):
    _enable_installation_llm(monkeypatch)
    project, reviewer, *_ = setup_matrix_project(db)
    rq = _add_research_question(db, project)
    outsider = create_user(db, "rq-outsider", "Outsider", "outsider-password")
    db.commit()

    csrf = login(client, reviewer.username, "reviewer-password")
    ok = client.get(
        f"/api/v1/projects/{project.id}/research-questions/{rq.id}/analysis"
    )
    assert ok.status_code == 200
    body = ok.json()
    assert body["researchQuestionId"] == rq.id
    assert body["latestRun"] is None

    regenerate = client.post(
        f"/api/v1/projects/{project.id}/research-questions/{rq.id}/analysis/regenerate",
        headers={"X-CSRF-Token": csrf},
    )
    assert regenerate.status_code == 200
    assert "jobId" in regenerate.json()

    history = client.get(
        f"/api/v1/projects/{project.id}/research-questions/{rq.id}/analysis/history"
    )
    assert history.status_code == 200
    assert len(history.json()) == 1

    client.post("/api/v1/auth/logout", headers={"X-CSRF-Token": csrf})
    login(client, outsider.username, "outsider-password")
    forbidden = client.get(
        f"/api/v1/projects/{project.id}/research-questions/{rq.id}/analysis"
    )
    assert forbidden.status_code == 403


def test_regenerate_rejected_when_installation_llm_disabled(client, db):
    project, reviewer, *_ = setup_matrix_project(db)
    rq = _add_research_question(db, project)
    csrf = login(client, reviewer.username, "reviewer-password")

    response = client.post(
        f"/api/v1/projects/{project.id}/research-questions/{rq.id}/analysis/regenerate",
        headers={"X-CSRF-Token": csrf},
    )
    assert response.status_code == 400


def test_regenerate_rejected_when_project_narrative_disabled(client, db, monkeypatch):
    from app.llm.schema_service import project_settings

    _enable_installation_llm(monkeypatch)
    project, reviewer, *_ = setup_matrix_project(db)
    rq = _add_research_question(db, project)
    settings = project_settings(db, project.id, create=True)
    settings.analysis_narrative_enabled = False
    db.commit()

    csrf = login(client, reviewer.username, "reviewer-password")
    response = client.post(
        f"/api/v1/projects/{project.id}/research-questions/{rq.id}/analysis/regenerate",
        headers={"X-CSRF-Token": csrf},
    )
    assert response.status_code == 400


def test_analysis_not_stale_when_synthesis_disabled_after_prior_run(
    client, db, monkeypatch
):
    from app.llm.schema_service import project_settings

    _enable_installation_llm(monkeypatch)
    project, reviewer, *_ = setup_matrix_project(db)
    rq = _add_research_question(db, project)
    dataset = build_evidence_dataset(db, project.id)
    source_id = assign_source_ids(dataset)[0].id
    monkeypatch.setattr(
        "app.llm.rq_synthesis.create_ollama_client",
        lambda: FakeOllama(
            [
                {
                    "statements": [{"claim": "Finding.", "sourceIds": [source_id]}],
                    "limitations": [],
                }
            ]
        ),
    )
    run = queue_rq_synthesis(db, project.id, rq, created_by_id=None)
    db.commit()
    job = db.get(BackgroundJob, run.background_job_id)
    generate_rq_synthesis_job(db, job)
    db.commit()

    settings = project_settings(db, project.id, create=True)
    settings.analysis_narrative_enabled = False
    db.commit()

    csrf = login(client, reviewer.username, "reviewer-password")
    response = client.get(
        f"/api/v1/projects/{project.id}/research-questions/{rq.id}/analysis",
        headers={"X-CSRF-Token": csrf},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["synthesisEnabled"] is False
    assert body["latestRun"] is not None
    assert body["isStale"] is False
