from __future__ import annotations

from datetime import UTC, datetime

import pytest
from sqlalchemy import select

from app.accounts.service import create_user
from app.api.errors import NotFoundError
from app.conflicts.service import record_final_decision
from app.extraction.models import ExtractionConfig, ExtractionWorkItem
from app.extraction.service import (
    claim_next_extraction,
    initialize_extraction,
    submit_extraction,
)
from app.forms.models import FormKind
from app.forms.service import add_field, create_form
from app.llm.models import (
    EvidenceStatus,
    ExtractionSuggestionReview,
    LlmExtractionRun,
    LlmFieldSuggestion,
    LlmSchemaField,
    LlmSchemaVersion,
    LlmTaskType,
    ProcessingStatus,
    SuggestionDisposition,
    SuggestionStatus,
)
from app.projects.models import (
    Project,
    ProjectMembership,
    ProjectStage,
    ReviewType,
    ScreeningStage,
    TaskAllocationMode,
)
from app.publications.models import Publication
from app.quality.models import QualityConfig, QualityWorkItem
from app.quality.service import initialize_quality, submit_quality
from app.reporting.evidence_dataset import build_evidence_dataset
from app.reporting.evidence_matrix import (
    build_evidence_matrix,
    evidence_cell_detail,
    matches_filter,
)


def setup_matrix_project(db):
    """Single-reviewer mode, quality enabled. Three publications: one fully
    extracted and quality-assessed ("Complete Paper"), one included but not
    yet extracted ("Pending Paper"), and one that was screened out at
    full-text ("Excluded Paper") to prove it never enters the dataset."""
    reviewer = create_user(db, "matrix-reviewer", "Reviewer", "reviewer-password")
    project = Project(
        name="Matrix Review",
        review_type=ReviewType.SYSTEMATIC_REVIEW,
        random_seed="seed",
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
    extraction_form = create_form(
        db, "Extraction", FormKind.EXTRACTION, project_id=project.id
    )
    fields = {
        "design": add_field(
            db, extraction_form, "Design", "single_select", options=["RCT", "Cohort"]
        ),
        "sample_size": add_field(db, extraction_form, "Sample size", "number"),
        "themes": add_field(
            db, extraction_form, "Themes", "multiple_select", options=["A", "B", "C"]
        ),
        "summary": add_field(db, extraction_form, "Summary", "long_text"),
    }
    db.add(
        ExtractionConfig(
            project_id=project.id, allocation_mode=TaskAllocationMode.CLAIM
        )
    )
    quality_form = create_form(db, "Quality", FormKind.QUALITY, project_id=project.id)
    quality_field = add_field(
        db, quality_form, "Rigor", "rating", scoring={"weight": 1}
    )
    db.add(
        QualityConfig(
            project_id=project.id,
            enabled=True,
            mode="both",
            aggregation="sum",
            allocation_mode=TaskAllocationMode.CLAIM,
        )
    )

    complete_pub = Publication(project_id=project.id, title="Complete Paper")
    pending_pub = Publication(project_id=project.id, title="Pending Paper")
    excluded_pub = Publication(project_id=project.id, title="Excluded Paper")
    db.add_all([complete_pub, pending_pub, excluded_pub])
    db.flush()
    for pub in (complete_pub, pending_pub):
        record_final_decision(
            db, pub.id, ScreeningStage.FULL_TEXT, "include", "agreement", None, None
        )
    record_final_decision(
        db,
        excluded_pub.id,
        ScreeningStage.FULL_TEXT,
        "exclude",
        "agreement",
        None,
        None,
    )
    project.stage = ProjectStage.EXTRACTION
    db.commit()

    initialize_extraction(db, project)
    initialize_quality(db, project)
    db.commit()

    complete_answers = {
        fields["design"].stable_key: "RCT",
        fields["sample_size"].stable_key: 120,
        fields["themes"].stable_key: ["A", "B"],
        fields["summary"].stable_key: "A well-conducted trial.",
    }
    item = db.scalar(
        select(ExtractionWorkItem).where(
            ExtractionWorkItem.publication_id == complete_pub.id
        )
    )
    assert item is not None
    item.assigned_reviewer_id = reviewer.id
    db.flush()
    response = submit_extraction(db, item, reviewer.id, complete_answers)
    quality_item = db.scalar(
        select(QualityWorkItem).where(QualityWorkItem.publication_id == complete_pub.id)
    )
    quality_item.assigned_reviewer_id = reviewer.id
    db.flush()
    submit_quality(db, quality_item, reviewer.id, {quality_field.stable_key: 4})
    db.commit()

    return (
        project,
        reviewer,
        fields,
        quality_field,
        complete_pub,
        pending_pub,
        excluded_pub,
        response,
    )


def attach_accepted_suggestion(
    db, project, response, field_stable_key, value, evidence
):
    schema_version = LlmSchemaVersion(project_id=project.id, version_number=1)
    db.add(schema_version)
    db.flush()
    schema_field = LlmSchemaField(
        schema_version_id=schema_version.id,
        label="Design",
        instruction="Extract the study design.",
        field_type="single_select",
        mapped_extraction_field_key=field_stable_key,
        options=["RCT", "Cohort"],
        position=0,
    )
    db.add(schema_field)
    db.flush()
    run = LlmExtractionRun(
        project_id=project.id,
        publication_id=response.work_item.publication_id,
        task_type=LlmTaskType.DATA_EXTRACTION,
        schema_version_id=schema_version.id,
        provider="ollama",
        model="test-model:latest",
        model_configuration={"temperature": 0},
        prompt_template_version="extraction_v1",
        status=ProcessingStatus.COMPLETED,
        queued_at=datetime.now(UTC),
        completed_at=datetime.now(UTC),
    )
    db.add(run)
    db.flush()
    suggestion = LlmFieldSuggestion(
        run_id=run.id,
        schema_field_id=schema_field.id,
        mapped_extraction_field_key=field_stable_key,
        value=value,
        status=SuggestionStatus.EXPLICIT,
        evidence=evidence,
        evidence_validation_status=EvidenceStatus.VERIFIED,
    )
    db.add(suggestion)
    db.flush()

    # submit_extraction always creates one ExtractionSuggestionReview row per
    # answered field (defaulting to NOT_USED when no matching LLM run exists
    # yet, per app.llm.service.record_suggestion_provenance) -- patch that
    # existing row rather than inserting a second one (unique per
    # extraction_response_id + extraction_field_key).
    review = db.scalar(
        select(ExtractionSuggestionReview).where(
            ExtractionSuggestionReview.extraction_response_id == response.id,
            ExtractionSuggestionReview.extraction_field_key == field_stable_key,
        )
    )
    assert review is not None
    review.disposition = SuggestionDisposition.ACCEPTED
    review.suggestion_id = suggestion.id
    review.reviewer_final_value = value
    db.commit()
    return suggestion


# ---------------------------------------------------------------------------
# build_evidence_dataset
# ---------------------------------------------------------------------------


def test_dataset_only_includes_publications_with_a_valid_include_decision(db):
    project, *_rest, excluded_pub, _response = setup_matrix_project(db)
    dataset = build_evidence_dataset(db, project.id)
    publication_ids = {p.id for p in dataset.publications}
    assert excluded_pub.id not in publication_ids


def test_dataset_reports_answered_values_for_a_completed_publication(db):
    project, _reviewer, fields, quality_field, complete_pub, *_ = setup_matrix_project(
        db
    )
    dataset = build_evidence_dataset(db, project.id)
    facts = dataset.facts_for(complete_pub.id)
    design_fact = facts[f"extraction:{fields['design'].stable_key}"]
    assert design_fact.state == "answered"
    assert design_fact.value == "RCT"
    assert design_fact.resolution_method == "single_reviewer"
    rigor_fact = facts[f"quality:{quality_field.stable_key}"]
    assert rigor_fact.state == "answered"
    assert rigor_fact.value == 4


def test_dataset_reports_missing_for_a_publication_not_yet_extracted(db):
    (
        project,
        _reviewer,
        fields,
        quality_field,
        _complete,
        pending_pub,
        *_,
    ) = setup_matrix_project(db)
    dataset = build_evidence_dataset(db, project.id)
    facts = dataset.facts_for(pending_pub.id)
    design_fact = facts[f"extraction:{fields['design'].stable_key}"]
    assert design_fact.state == "missing"
    assert design_fact.value is None
    rigor_fact = facts[f"quality:{quality_field.stable_key}"]
    assert rigor_fact.state == "missing"


def test_dataset_marks_pending_reconciliation_distinctly_from_missing(db):
    admin = create_user(db, "matrix-admin", "Admin", "secret-password", is_admin=True)
    r1 = create_user(db, "matrix-r1", "R1", "long-password-1")
    r2 = create_user(db, "matrix-r2", "R2", "long-password-2")
    project = Project(
        name="Dual Matrix", review_type=ReviewType.SYSTEMATIC_REVIEW, random_seed="seed"
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
    outcome_field = add_field(
        db, form, "Outcome", "single_select", options=["Positive", "Negative"]
    )
    publication = Publication(project_id=project.id, title="Disagreement Paper")
    db.add(publication)
    db.flush()
    record_final_decision(
        db, publication.id, ScreeningStage.FULL_TEXT, "include", "agreement", None, None
    )
    project.stage = ProjectStage.EXTRACTION
    db.commit()
    initialize_extraction(db, project)
    db.commit()

    item_a = claim_next_extraction(db, project.id, r1.id)
    submit_extraction(db, item_a, r1.id, {outcome_field.stable_key: "Positive"})
    item_b = claim_next_extraction(db, project.id, r2.id)
    submit_extraction(db, item_b, r2.id, {outcome_field.stable_key: "Negative"})
    db.commit()
    assert admin.id  # keep admin referenced; not otherwise needed

    dataset = build_evidence_dataset(db, project.id)
    fact = dataset.facts_for(publication.id)[f"extraction:{outcome_field.stable_key}"]
    assert fact.state == "pending_reconciliation"
    assert fact.value is None


def test_evidence_traceable_when_suggestion_accepted_and_value_unchanged(db):
    project, _reviewer, fields, *_, response = setup_matrix_project(db)
    evidence = [
        {
            "page": 3,
            "quote": "Randomized controlled trial",
            "section": "Methods",
            "verified": True,
        }
    ]
    attach_accepted_suggestion(
        db, project, response, fields["design"].stable_key, "RCT", evidence
    )

    dataset = build_evidence_dataset(db, project.id)
    fact = dataset.facts_for(response.work_item.publication_id)[
        f"extraction:{fields['design'].stable_key}"
    ]
    assert len(fact.evidence) == 1
    assert fact.evidence[0].quote == "Randomized controlled trial"
    assert fact.evidence[0].page == 3


def test_no_evidence_when_reviewer_modified_value_after_suggestion(db):
    project, _reviewer, fields, *_, response = setup_matrix_project(db)
    # Suggestion said "Cohort", but the reviewer actually answered "RCT" --
    # never accepted, so no evidence should be inherited even though a
    # suggestion for this field exists.
    evidence = [{"page": 1, "quote": "irrelevant", "section": None, "verified": False}]
    suggestion = attach_accepted_suggestion(
        db, project, response, fields["design"].stable_key, "Cohort", evidence
    )
    review = db.scalar(
        select(ExtractionSuggestionReview).where(
            ExtractionSuggestionReview.extraction_response_id == response.id,
            ExtractionSuggestionReview.extraction_field_key
            == fields["design"].stable_key,
        )
    )
    review.disposition = SuggestionDisposition.MODIFIED
    review.suggestion_id = suggestion.id
    db.commit()

    dataset = build_evidence_dataset(db, project.id)
    fact = dataset.facts_for(response.work_item.publication_id)[
        f"extraction:{fields['design'].stable_key}"
    ]
    assert fact.evidence == []


# ---------------------------------------------------------------------------
# build_evidence_matrix
# ---------------------------------------------------------------------------


def test_matrix_search_matches_title_and_field_value(db):
    project, _reviewer, fields, *_ = setup_matrix_project(db)
    by_title = build_evidence_matrix(db, project.id, search="Complete")
    assert by_title["total"] == 1
    assert by_title["items"][0]["publication"]["title"] == "Complete Paper"

    by_value = build_evidence_matrix(db, project.id, search="well-conducted")
    assert by_value["total"] == 1


def test_matrix_pending_reconciliation_cell_never_looks_like_a_final_answer(db):
    project, _reviewer, fields, *_ = setup_matrix_project(db)
    matrix = build_evidence_matrix(db, project.id)
    complete_item = next(
        item
        for item in matrix["items"]
        if item["publication"]["title"] == "Complete Paper"
    )
    pending_item = next(
        item
        for item in matrix["items"]
        if item["publication"]["title"] == "Pending Paper"
    )
    design_key = f"extraction:{fields['design'].stable_key}"
    assert complete_item["cells"][design_key]["state"] == "answered"
    assert pending_item["cells"][design_key]["state"] == "missing"
    assert pending_item["cells"][design_key]["value"] is None


def test_matrix_pagination_slices_and_reports_total(db):
    project, _reviewer, *_ = setup_matrix_project(db)
    page1 = build_evidence_matrix(db, project.id, page=1, page_size=1)
    page2 = build_evidence_matrix(db, project.id, page=2, page_size=1)
    assert page1["total"] == 2
    assert len(page1["items"]) == 1
    assert len(page2["items"]) == 1
    assert (
        page1["items"][0]["publication"]["id"] != page2["items"][0]["publication"]["id"]
    )


def test_matrix_evidence_flag_reflects_traceable_evidence(db):
    project, _reviewer, fields, *_, response = setup_matrix_project(db)
    evidence = [{"page": 2, "quote": "quote", "section": None, "verified": True}]
    attach_accepted_suggestion(
        db, project, response, fields["design"].stable_key, "RCT", evidence
    )
    matrix = build_evidence_matrix(db, project.id)
    complete_item = next(
        item
        for item in matrix["items"]
        if item["publication"]["title"] == "Complete Paper"
    )
    design_key = f"extraction:{fields['design'].stable_key}"
    assert complete_item["cells"][design_key]["hasEvidence"] is True


# --- filter predicates (pure, hand-fixture) ---------------------------------


def _fact(**overrides):
    from app.reporting.evidence_dataset import EvidenceFact

    base = dict(
        publication_id="pub-1",
        source_type="extraction",
        field_key="k",
        label="Label",
        field_type="short_text",
        value="hello",
        state="answered",
        resolution_method="single_reviewer",
        resolved_at=None,
        resolved_by_id=None,
        version_ref="final-1",
    )
    base.update(overrides)
    return EvidenceFact(**base)


def test_presence_filter_matches_state_directly():
    assert matches_filter(
        _fact(state="answered"), {"type": "presence", "state": "answered"}
    )
    assert not matches_filter(
        _fact(state="missing"), {"type": "presence", "state": "answered"}
    )
    assert matches_filter(None, {"type": "presence", "state": "missing"})


def test_text_filter_is_case_insensitive_substring():
    assert matches_filter(
        _fact(value="A Randomized Trial"), {"type": "text", "contains": "randomized"}
    )
    assert not matches_filter(
        _fact(value="A Randomized Trial"), {"type": "text", "contains": "cohort"}
    )


def test_categorical_filter_matches_any_selected_value():
    assert matches_filter(
        _fact(value="RCT"), {"type": "categorical", "values": ["RCT", "Cohort"]}
    )
    assert not matches_filter(
        _fact(value="Survey"), {"type": "categorical", "values": ["RCT", "Cohort"]}
    )


def test_multi_select_filter_matches_on_overlap():
    fact = _fact(value=["A", "B"])
    assert matches_filter(fact, {"type": "multi_select", "anyOf": ["B", "C"]})
    assert not matches_filter(fact, {"type": "multi_select", "anyOf": ["C"]})


def test_numeric_filter_respects_min_and_max():
    fact = _fact(value=42)
    assert matches_filter(fact, {"type": "numeric", "min": 10, "max": 50})
    assert not matches_filter(fact, {"type": "numeric", "min": 43})
    assert not matches_filter(fact, {"type": "numeric", "max": 41})


def test_unanswered_fact_never_matches_a_value_based_filter():
    missing = _fact(state="missing", value=None)
    assert not matches_filter(missing, {"type": "text", "contains": "anything"})
    assert not matches_filter(missing, {"type": "numeric", "min": 0})


# ---------------------------------------------------------------------------
# evidence_cell_detail
# ---------------------------------------------------------------------------


def test_cell_detail_returns_value_and_evidence(db):
    (
        project,
        _reviewer,
        fields,
        *_,
        complete_pub,
        _pending,
        _excluded,
        response,
    ) = setup_matrix_project(db)
    evidence = [
        {"page": 5, "quote": "quote text", "section": "Results", "verified": True}
    ]
    attach_accepted_suggestion(
        db, project, response, fields["design"].stable_key, "RCT", evidence
    )

    detail = evidence_cell_detail(
        db, project.id, complete_pub.id, "extraction", fields["design"].stable_key
    )
    assert detail["value"] == "RCT"
    assert detail["resolutionMethod"] == "single_reviewer"
    assert detail["evidence"][0]["quote"] == "quote text"


def test_cell_detail_raises_not_found_for_unknown_field(db):
    project, _reviewer, _fields, _quality, complete_pub, *_ = setup_matrix_project(db)
    with pytest.raises(NotFoundError):
        evidence_cell_detail(
            db, project.id, complete_pub.id, "extraction", "not-a-real-key"
        )


def test_cell_detail_raises_not_found_for_excluded_publication(db):
    project, *_rest, excluded_pub, _response = setup_matrix_project(db)
    with pytest.raises(NotFoundError):
        evidence_cell_detail(db, project.id, excluded_pub.id, "extraction", "anything")


# ---------------------------------------------------------------------------
# routes: permission
# ---------------------------------------------------------------------------


def test_evidence_matrix_route_requires_project_membership(client, db):
    project, reviewer, *_ = setup_matrix_project(db)
    outsider = create_user(db, "matrix-outsider", "Outsider", "outsider-password")
    db.commit()

    login = client.post(
        "/api/v1/auth/login",
        json={"username": reviewer.username, "password": "reviewer-password"},
    )
    assert login.status_code == 200
    ok = client.post(f"/api/v1/projects/{project.id}/evidence-matrix", json={})
    assert ok.status_code == 200
    assert ok.json()["total"] == 2
    client.post(
        "/api/v1/auth/logout", headers={"X-CSRF-Token": login.json()["csrfToken"]}
    )

    outsider_login = client.post(
        "/api/v1/auth/login",
        json={"username": outsider.username, "password": "outsider-password"},
    )
    assert outsider_login.status_code == 200
    forbidden = client.post(f"/api/v1/projects/{project.id}/evidence-matrix", json={})
    assert forbidden.status_code == 403
