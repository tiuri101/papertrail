from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import select

from app.accounts.service import create_user
from app.analysis.jobs import generate_stage_analysis_job
from app.analysis.models import StageAnalysis
from app.analysis.service import (
    compute_duplicate_review_stats,
    compute_extraction_stats,
    compute_full_text_stats,
    compute_stats_fingerprint,
    compute_title_abstract_stats,
)
from app.conflicts.service import record_final_decision
from app.core.config import get_settings
from app.deduplication.models import DuplicateCandidate, PublicationMerge
from app.extraction.service import (
    claim_next_extraction,
    initialize_extraction,
    submit_extraction,
)
from app.forms.models import FormKind
from app.forms.service import add_field, create_form
from app.fulltext.models import FullTextRetrieval, RetrievalStatus
from app.jobs.models import BackgroundJob, JobStatus
from app.llm.schema_service import project_settings
from app.projects.models import (
    Criterion,
    CriterionKind,
    Project,
    ProjectMembership,
    ProjectStage,
    ScreeningStage,
)
from app.publications.models import Publication
from app.quality.models import QualityConfig
from app.quality.service import claim_next_quality, initialize_quality, submit_quality
from app.screening.models import ScreeningDecision, ScreeningOutcome, ScreeningWorkItem


def _enable_installation_llm(monkeypatch) -> None:
    settings = get_settings()
    monkeypatch.setattr(settings, "llm_enabled", True)
    monkeypatch.setattr(settings, "ollama_base_url", "http://ollama.example:11434")
    monkeypatch.setattr(settings, "ollama_model", "test-model:latest")


def login(client, username: str, password: str) -> str:
    response = client.post(
        "/api/v1/auth/login", json={"username": username, "password": password}
    )
    assert response.status_code == 200
    return response.json()["csrfToken"]


def _seed_extraction_project(db):
    reviewer = create_user(db, "reviewer", "Reviewer", "long-password-1")
    project = Project(
        name="Review",
        review_type="systematic_review",
        random_seed="seed",
        stage=ProjectStage.COMPLETED,
    )
    db.add(project)
    db.flush()
    db.add(
        ProjectMembership(
            project_id=project.id,
            user_id=reviewer.id,
            can_extract=True,
            can_assess_quality=True,
        )
    )
    db.add(
        QualityConfig(
            project_id=project.id, enabled=True, mode="both", aggregation="sum"
        )
    )

    extraction_form = create_form(
        db, "Extraction", FormKind.EXTRACTION, project_id=project.id
    )
    design_field = add_field(
        db,
        extraction_form,
        "Study design",
        "single_select",
        required=False,
        options=["RCT", "Cohort"],
    )
    sample_size_field = add_field(
        db, extraction_form, "Sample size", "number", required=False
    )

    quality_form = create_form(db, "Quality", FormKind.QUALITY, project_id=project.id)
    risk_field = add_field(
        db,
        quality_form,
        "Risk of bias",
        "single_select",
        required=False,
        options=["Low", "High"],
    )

    publications = [
        Publication(project_id=project.id, title=f"Paper {i}") for i in range(3)
    ]
    db.add_all(publications)
    db.flush()
    for publication in publications:
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

    initialize_extraction(db, project)
    initialize_quality(db, project)
    db.commit()

    answers = [
        {design_field.stable_key: "RCT", sample_size_field.stable_key: 10},
        {design_field.stable_key: "RCT", sample_size_field.stable_key: 20},
        {},
    ]
    for answer in answers:
        item = claim_next_extraction(db, project.id, reviewer.id)
        submit_extraction(db, item, reviewer.id, answer)
    db.commit()

    quality_answers = [
        {risk_field.stable_key: "Low"},
        {risk_field.stable_key: "High"},
        {},
    ]
    for answer in quality_answers:
        item = claim_next_quality(db, project.id, reviewer.id)
        submit_quality(db, item, reviewer.id, answer)
    project.stage = ProjectStage.COMPLETED
    db.commit()

    return project


def test_compute_extraction_stats_counts_options_and_numeric_fields(db) -> None:
    project = _seed_extraction_project(db)

    stats = compute_extraction_stats(db, project.id)

    assert stats["totalPublications"] == 3
    assert stats["completedExtractions"] == 3
    fields_by_label = {field["label"]: field for field in stats["fields"]}

    design = fields_by_label["Study design"]
    assert design["answeredCount"] == 2
    assert design["totalCount"] == 3
    assert design["optionCounts"] == [{"option": "RCT", "count": 2}]

    sample_size = fields_by_label["Sample size"]
    assert sample_size["answeredCount"] == 2
    assert sample_size["numericStats"]["min"] == 10
    assert sample_size["numericStats"]["max"] == 20

    risk = fields_by_label["Risk of bias"]
    assert risk["source"] == "quality"
    assert risk["answeredCount"] == 2


def test_compute_extraction_stats_uses_consensus_not_an_unresolved_response(db) -> None:
    """Dual-extraction mode: stats must aggregate over the authoritative
    FinalExtraction, never an individual reviewer's response -- a
    publication still awaiting reconciliation must not be counted as
    answered at all."""
    from app.extraction.models import ExtractionConfig
    from app.extraction.service import extraction_required_reviewers

    admin = create_user(db, "admin", "Admin", "secret-password", is_admin=True)
    r1 = create_user(db, "r1", "R1", "long-password-1")
    r2 = create_user(db, "r2", "R2", "long-password-2")
    project = Project(
        name="Dual",
        review_type="systematic_review",
        random_seed="seed",
        stage=ProjectStage.FULL_TEXT,
    )
    db.add(project)
    db.flush()
    for reviewer in (r1, r2):
        db.add(
            ProjectMembership(
                project_id=project.id, user_id=reviewer.id, can_extract=True
            )
        )
    db.add(ExtractionConfig(project_id=project.id, required_reviewers=2))
    form = create_form(db, "Extraction", FormKind.EXTRACTION, project_id=project.id)
    field = add_field(
        db,
        form,
        "Outcome",
        "single_select",
        required=True,
        options=["Positive", "Negative"],
    )
    publication = Publication(project_id=project.id, title="Disagreeing paper")
    db.add(publication)
    db.flush()
    record_final_decision(
        db, publication.id, ScreeningStage.FULL_TEXT, "include", "agreement", None, None
    )
    project.stage = ProjectStage.EXTRACTION
    db.commit()
    initialize_extraction(db, project)
    db.commit()
    assert extraction_required_reviewers(db, project.id) == 2

    item_r1 = claim_next_extraction(db, project.id, r1.id)
    assert item_r1 is not None
    submit_extraction(db, item_r1, r1.id, {field.stable_key: "Positive"})
    item_r2 = claim_next_extraction(db, project.id, r2.id)
    assert item_r2 is not None
    submit_extraction(db, item_r2, r2.id, {field.stable_key: "Negative"})
    db.commit()

    stats = compute_extraction_stats(db, project.id)
    assert stats["completedExtractions"] == 0
    fields_by_label = {field["label"]: field for field in stats["fields"]}
    outcome = fields_by_label["Outcome"]
    assert outcome["answeredCount"] == 0
    assert outcome["totalCount"] == 1

    from app.extraction.reconciliation import submit_reconciliation

    submit_reconciliation(
        db,
        publication.id,
        admin.id,
        {field.stable_key: {"choice": "response_a"}},
        "Resolved",
    )
    db.commit()

    stats_after = compute_extraction_stats(db, project.id)
    assert stats_after["completedExtractions"] == 1
    outcome_after = {f["label"]: f for f in stats_after["fields"]}["Outcome"]
    assert outcome_after["answeredCount"] == 1


def _project(db) -> Project:
    project = Project(
        name="Review", review_type="systematic_review", random_seed="seed"
    )
    db.add(project)
    db.flush()
    return project


def test_compute_duplicate_review_stats_counts_removals_and_match_reasons(db) -> None:
    project = _project(db)
    canonical = Publication(project_id=project.id, title="Canonical")
    merged = Publication(project_id=project.id, title="Merged away", is_active=False)
    standalone = Publication(project_id=project.id, title="Standalone")
    db.add_all([canonical, merged, standalone])
    db.flush()
    candidate = DuplicateCandidate(
        project_id=project.id,
        publication_a_id=canonical.id,
        publication_b_id=merged.id,
        match_reasons=["title_match", "doi_match"],
        confidence=0.92,
        status="duplicate",
    )
    db.add(candidate)
    db.flush()
    db.add(
        PublicationMerge(
            project_id=project.id,
            canonical_publication_id=canonical.id,
            merged_publication_id=merged.id,
            candidate_id=candidate.id,
            canonical_before={},
            merged_before={},
            moved_source_ids=[],
        )
    )
    db.commit()

    stats = compute_duplicate_review_stats(db, project.id)

    assert stats["duplicatesRemoved"] == 1
    assert stats["matchReasonCounts"] == [
        {"label": "title_match", "count": 1},
        {"label": "doi_match", "count": 1},
    ]
    assert stats["uniqueRecordsRemaining"] == stats["recordsIdentified"] - 1


def _add_criterion(db, project, kind, text, position=0) -> Criterion:
    criterion = Criterion(
        project_id=project.id, kind=kind, text=text, position=position, is_active=True
    )
    db.add(criterion)
    db.flush()
    return criterion


def _screen(
    db,
    project,
    publication,
    stage,
    outcome,
    criteria_answers,
    reviewer_id,
) -> None:
    work_item = ScreeningWorkItem(
        project_id=project.id,
        publication_id=publication.id,
        stage=stage,
        slot_number=0,
        assigned_reviewer_id=reviewer_id,
        random_rank="rank",
    )
    db.add(work_item)
    db.flush()
    db.add(
        ScreeningDecision(
            work_item_id=work_item.id,
            reviewer_id=reviewer_id,
            outcome=outcome,
            criteria_answers=criteria_answers,
            version=1,
        )
    )
    db.flush()
    record_final_decision(
        db, publication.id, stage, outcome.value, "agreement", None, None
    )


def test_compute_title_abstract_stats_breaks_down_outcomes_and_exclusion_reasons(
    db,
) -> None:
    project = _project(db)
    reviewer = create_user(db, "screener", "Screener", "long-password-1")
    population = _add_criterion(
        db, project, CriterionKind.INCLUSION, "Population matches"
    )
    language = _add_criterion(db, project, CriterionKind.EXCLUSION, "Non-English")

    included = Publication(project_id=project.id, title="Included paper")
    excluded_by_inclusion = Publication(project_id=project.id, title="Wrong population")
    excluded_by_exclusion = Publication(
        project_id=project.id, title="Non-English paper"
    )
    db.add_all([included, excluded_by_inclusion, excluded_by_exclusion])
    db.flush()

    _screen(
        db,
        project,
        included,
        ScreeningStage.TITLE_ABSTRACT,
        ScreeningOutcome.INCLUDE,
        {population.id: True, language.id: False},
        reviewer.id,
    )
    _screen(
        db,
        project,
        excluded_by_inclusion,
        ScreeningStage.TITLE_ABSTRACT,
        ScreeningOutcome.EXCLUDE,
        {population.id: False, language.id: False},
        reviewer.id,
    )
    _screen(
        db,
        project,
        excluded_by_exclusion,
        ScreeningStage.TITLE_ABSTRACT,
        ScreeningOutcome.EXCLUDE,
        {population.id: True, language.id: True},
        reviewer.id,
    )
    db.commit()

    stats = compute_title_abstract_stats(db, project.id)

    assert stats["recordsScreened"] == 3
    assert stats["recordsExcluded"] == 2
    outcome_counts = {item["label"]: item["count"] for item in stats["outcomeCounts"]}
    assert outcome_counts["Included"] == 1
    assert outcome_counts["Excluded"] == 2
    reason_counts = {
        item["label"]: item["count"] for item in stats["exclusionReasonCounts"]
    }
    assert reason_counts["Population matches"] == 1
    assert reason_counts["Non-English"] == 1


def test_compute_full_text_stats_breaks_down_retrieval_and_outcomes(db) -> None:
    project = _project(db)
    reviewer = create_user(db, "assessor", "Assessor", "long-password-1")
    criterion = _add_criterion(db, project, CriterionKind.EXCLUSION, "Wrong outcome")

    included = Publication(project_id=project.id, title="Included paper")
    excluded = Publication(project_id=project.id, title="Excluded paper")
    not_found = Publication(project_id=project.id, title="Missing full text")
    db.add_all([included, excluded, not_found])
    db.flush()
    db.add(
        FullTextRetrieval(
            project_id=project.id,
            publication_id=not_found.id,
            status=RetrievalStatus.NOT_FOUND,
        )
    )
    db.commit()

    _screen(
        db,
        project,
        included,
        ScreeningStage.FULL_TEXT,
        ScreeningOutcome.INCLUDE,
        {criterion.id: False},
        reviewer.id,
    )
    _screen(
        db,
        project,
        excluded,
        ScreeningStage.FULL_TEXT,
        ScreeningOutcome.EXCLUDE,
        {criterion.id: True},
        reviewer.id,
    )
    db.commit()

    stats = compute_full_text_stats(db, project.id)

    assert stats["reportsAssessed"] == 2
    assert stats["includedPublications"] == 1
    assert stats["reportsNotRetrieved"] == 1
    retrieval_counts = {
        item["label"]: item["count"] for item in stats["retrievalStatusCounts"]
    }
    assert retrieval_counts["Not found"] == 1
    reason_counts = {
        item["label"]: item["count"] for item in stats["exclusionReasonCounts"]
    }
    assert reason_counts["Wrong outcome"] == 1


def test_compute_stats_fingerprint_changes_when_stats_change() -> None:
    stats_a = {"a": 1, "b": [{"label": "x", "count": 1}]}
    stats_b = {"a": 1, "b": [{"label": "x", "count": 2}]}
    assert compute_stats_fingerprint(stats_a) == compute_stats_fingerprint(
        dict(stats_a)
    )
    assert compute_stats_fingerprint(stats_a) != compute_stats_fingerprint(stats_b)


def test_project_stage_analysis_endpoint_reports_staleness(
    client, db, monkeypatch
) -> None:
    _enable_installation_llm(monkeypatch)
    project = _seed_extraction_project(db)
    create_user(db, "admin", "Administrator", "secret-password", is_admin=True)
    db.commit()
    login(client, "admin", "secret-password")

    fresh = client.get(f"/api/v1/projects/{project.id}/analysis/extraction_quality")
    assert fresh.status_code == 200
    body = fresh.json()
    assert body["narrative"] is None
    assert body["isStale"] is True

    stats = body["stats"]
    db.add(
        StageAnalysis(
            project_id=project.id,
            stage="extraction_quality",
            summary="Looks fine.",
            stats_fingerprint=compute_stats_fingerprint(stats),
            generated_at=datetime.now(UTC),
        )
    )
    db.commit()

    current = client.get(f"/api/v1/projects/{project.id}/analysis/extraction_quality")
    assert current.status_code == 200
    current_body = current.json()
    assert current_body["narrative"]["summary"] == "Looks fine."
    assert current_body["isStale"] is False


def test_project_stage_analysis_hides_narrative_when_disabled(client, db) -> None:
    project = _seed_extraction_project(db)
    create_user(db, "admin", "Administrator", "secret-password", is_admin=True)
    db.commit()
    login(client, "admin", "secret-password")

    settings = project_settings(db, project.id, create=True)
    settings.analysis_narrative_enabled = False
    db.commit()

    stats = compute_extraction_stats(db, project.id)
    db.add(
        StageAnalysis(
            project_id=project.id,
            stage="extraction_quality",
            summary="Looks fine.",
            stats_fingerprint=compute_stats_fingerprint(stats),
            generated_at=datetime.now(UTC),
        )
    )
    db.commit()

    response = client.get(f"/api/v1/projects/{project.id}/analysis/extraction_quality")
    assert response.status_code == 200
    body = response.json()
    assert body["narrativeEnabled"] is False
    assert body["narrative"] is None


def test_regenerate_stage_analysis_rejected_when_narrative_disabled(
    client, db, monkeypatch
) -> None:
    _enable_installation_llm(monkeypatch)
    project = _seed_extraction_project(db)
    create_user(db, "admin", "Administrator", "secret-password", is_admin=True)
    db.commit()
    csrf = login(client, "admin", "secret-password")

    settings = project_settings(db, project.id, create=True)
    settings.analysis_narrative_enabled = False
    db.commit()

    response = client.post(
        f"/api/v1/projects/{project.id}/analysis/extraction_quality/regenerate",
        headers={"X-CSRF-Token": csrf},
    )
    assert response.status_code == 400


def test_regenerate_stage_analysis_rejected_when_installation_llm_disabled(
    client, db
) -> None:
    """The project-level toggle defaults to enabled, so with the
    installation-wide "LLM enabled" checkbox off, regeneration must still be
    rejected -- the project setting alone is not enough to bypass it."""
    project = _seed_extraction_project(db)
    create_user(db, "admin", "Administrator", "secret-password", is_admin=True)
    db.commit()
    csrf = login(client, "admin", "secret-password")

    response = client.post(
        f"/api/v1/projects/{project.id}/analysis/extraction_quality/regenerate",
        headers={"X-CSRF-Token": csrf},
    )
    assert response.status_code == 400


def test_project_stage_analysis_hides_narrative_when_installation_llm_disabled(
    client, db
) -> None:
    project = _seed_extraction_project(db)
    create_user(db, "admin", "Administrator", "secret-password", is_admin=True)
    db.commit()
    login(client, "admin", "secret-password")

    stats = compute_extraction_stats(db, project.id)
    db.add(
        StageAnalysis(
            project_id=project.id,
            stage="extraction_quality",
            summary="Looks fine.",
            stats_fingerprint=compute_stats_fingerprint(stats),
            generated_at=datetime.now(UTC),
        )
    )
    db.commit()

    response = client.get(f"/api/v1/projects/{project.id}/analysis/extraction_quality")
    assert response.status_code == 200
    body = response.json()
    assert body["narrativeEnabled"] is False
    assert body["narrative"] is None


def test_project_stage_analysis_endpoint_rejects_unknown_stage(client, db) -> None:
    project = _seed_extraction_project(db)
    create_user(db, "admin", "Administrator", "secret-password", is_admin=True)
    db.commit()
    login(client, "admin", "secret-password")

    response = client.get(f"/api/v1/projects/{project.id}/analysis/not-a-stage")
    assert response.status_code == 404


def test_project_stage_analysis_exposes_only_completed_stages(client, db) -> None:
    project = _seed_extraction_project(db)
    project.stage = ProjectStage.EXTRACTION
    create_user(db, "admin", "Administrator", "secret-password", is_admin=True)
    db.commit()
    login(client, "admin", "secret-password")

    completed_stage = client.get(
        f"/api/v1/projects/{project.id}/analysis/full_text_screening"
    )
    active_stage = client.get(
        f"/api/v1/projects/{project.id}/analysis/extraction_quality"
    )

    assert completed_stage.status_code == 200
    assert active_stage.status_code == 400
    assert "only after" in active_stage.json()["error"]["message"]


def test_regenerate_stage_analysis_endpoint_enqueues_job(
    client, db, monkeypatch
) -> None:
    _enable_installation_llm(monkeypatch)
    project = _seed_extraction_project(db)
    create_user(db, "admin", "Administrator", "secret-password", is_admin=True)
    db.commit()
    csrf = login(client, "admin", "secret-password")

    response = client.post(
        f"/api/v1/projects/{project.id}/analysis/extraction_quality/regenerate",
        headers={"X-CSRF-Token": csrf},
    )

    assert response.status_code == 200
    job_id = response.json()["jobId"]
    job = db.get(BackgroundJob, job_id)
    assert job is not None
    assert job.job_type == "generate_stage_analysis"
    assert job.payload == {"stage": "extraction_quality"}


def test_generate_stage_analysis_job_persists_narrative(db, monkeypatch) -> None:
    _enable_installation_llm(monkeypatch)
    project = _seed_extraction_project(db)
    monkeypatch.setattr(
        "app.analysis.jobs.generate_narrative",
        lambda stage, stats: "Auto-generated summary.",
    )
    job = BackgroundJob(
        job_type="generate_stage_analysis",
        payload={"stage": "extraction_quality"},
        project_id=project.id,
    )
    db.add(job)
    db.flush()

    result = generate_stage_analysis_job(db, job)
    db.commit()

    assert result["summary"] == "Auto-generated summary."
    saved = db.scalar(
        select(StageAnalysis).where(
            StageAnalysis.project_id == project.id,
            StageAnalysis.stage == "extraction_quality",
        )
    )
    assert saved is not None
    assert saved.summary == "Auto-generated summary."

    # Re-running upserts the same row instead of creating a duplicate.
    monkeypatch.setattr(
        "app.analysis.jobs.generate_narrative",
        lambda stage, stats: "Updated summary.",
    )
    generate_stage_analysis_job(db, job)
    db.commit()
    rows = list(
        db.scalars(
            select(StageAnalysis).where(
                StageAnalysis.project_id == project.id,
                StageAnalysis.stage == "extraction_quality",
            )
        )
    )
    assert len(rows) == 1
    assert rows[0].summary == "Updated summary."


def test_generate_stage_analysis_job_skips_when_installation_llm_disabled(
    db, monkeypatch
) -> None:
    """Guards the race where a job is claimed just as the installation
    toggle flips off between enqueue and execution: it must not call
    Ollama or write a narrative."""
    project = _seed_extraction_project(db)
    called = False

    def _fail_if_called(stage, stats):
        nonlocal called
        called = True
        raise AssertionError("generate_narrative should not be called")

    monkeypatch.setattr("app.analysis.jobs.generate_narrative", _fail_if_called)
    job = BackgroundJob(
        job_type="generate_stage_analysis",
        payload={"stage": "extraction_quality"},
        project_id=project.id,
    )
    db.add(job)
    db.flush()

    result = generate_stage_analysis_job(db, job)
    db.commit()

    assert called is False
    assert result["status"] == "skipped"
    assert (
        db.scalar(
            select(StageAnalysis).where(
                StageAnalysis.project_id == project.id,
                StageAnalysis.stage == "extraction_quality",
            )
        )
        is None
    )


def test_disabling_installation_llm_cancels_queued_stage_analysis_job(
    client, db, monkeypatch
) -> None:
    _enable_installation_llm(monkeypatch)
    project = _seed_extraction_project(db)
    create_user(db, "admin", "Administrator", "secret-password", is_admin=True)
    db.commit()
    csrf = login(client, "admin", "secret-password")

    enqueued = client.post(
        f"/api/v1/projects/{project.id}/analysis/extraction_quality/regenerate",
        headers={"X-CSRF-Token": csrf},
    )
    assert enqueued.status_code == 200
    job = db.get(BackgroundJob, enqueued.json()["jobId"])
    assert job.status == JobStatus.QUEUED

    disabled = client.patch(
        "/api/v1/llm/installation-settings",
        json={
            "enabled": False,
            "endpoint": "http://ollama.example:11434",
            "model": "test-model:latest",
            "contextLength": 8192,
            "requestTimeoutSeconds": 300,
            "maxConcurrentJobs": 1,
            "maxEvidenceItems": 3,
            "maxEvidenceQuoteChars": 500,
        },
        headers={"X-CSRF-Token": csrf},
    )
    assert disabled.status_code == 200
    db.refresh(job)
    assert job.status == JobStatus.CANCELLED
