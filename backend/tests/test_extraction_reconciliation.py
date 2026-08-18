import pytest
from sqlalchemy import select

from app.accounts.models import User
from app.accounts.service import create_user
from app.api.errors import DomainError
from app.audit.models import AuditEvent
from app.conflicts.service import record_final_decision
from app.extraction.comparison import compare_answers, fields_agree
from app.extraction.final import get_current_final_extraction
from app.extraction.models import (
    ExtractionConfig,
    ExtractionWorkItem,
)
from app.extraction.reconciliation import (
    reconciliation_detail,
    reconciliation_queue,
    submit_reconciliation,
)
from app.extraction.service import (
    claim_next_extraction,
    extraction_required_reviewers,
    initialize_extraction,
    override_extraction,
    slot_responses_visible,
    submit_extraction,
    update_extraction_config,
)
from app.forms.models import FieldType, FormField, FormKind
from app.forms.service import add_field, create_form
from app.projects.models import (
    Project,
    ProjectMembership,
    ProjectStage,
    ReviewType,
    ScreeningStage,
    TaskAllocationMode,
)
from app.publications.models import Publication


def make_field(field_type: FieldType, *, stable_key: str = "f") -> FormField:
    return FormField(
        form_version_id="fv",
        stable_key=stable_key,
        label="Field",
        field_type=field_type,
        position=0,
    )


# ---------------------------------------------------------------------------
# comparison.py -- pure, hand-calculable unit tests, no DB
# ---------------------------------------------------------------------------


def test_single_select_agrees_only_on_exact_match():
    assert fields_agree(FieldType.SINGLE_SELECT, "Positive", "Positive") is True
    assert fields_agree(FieldType.SINGLE_SELECT, "Positive", "Negative") is False


def test_single_select_missing_values_normalized_consistently():
    assert fields_agree(FieldType.SINGLE_SELECT, None, "") is True
    assert fields_agree(FieldType.SINGLE_SELECT, None, "Positive") is False


def test_checkbox_missing_and_false_are_not_conflated():
    assert fields_agree(FieldType.CHECKBOX, None, False) is False
    assert fields_agree(FieldType.CHECKBOX, None, None) is True
    assert fields_agree(FieldType.CHECKBOX, False, False) is True
    assert fields_agree(FieldType.CHECKBOX, True, True) is True
    assert fields_agree(FieldType.CHECKBOX, True, False) is False


def test_multiple_select_compares_as_order_independent_sets():
    assert fields_agree(FieldType.MULTIPLE_SELECT, ["a", "b"], ["b", "a"]) is True
    assert fields_agree(FieldType.MULTIPLE_SELECT, ["a", "b"], ["a"]) is False
    assert fields_agree(FieldType.MULTIPLE_SELECT, [], []) is True
    assert fields_agree(FieldType.MULTIPLE_SELECT, [], None) is True


def test_numeric_fields_compare_exactly_after_type_coercion():
    assert fields_agree(FieldType.NUMBER, 5, 5) is True
    assert fields_agree(FieldType.NUMBER, 5, "5") is True
    assert fields_agree(FieldType.NUMBER, 5, 5.01) is False
    assert fields_agree(FieldType.RATING, 3, 3.0) is True
    assert fields_agree(FieldType.NUMBER, None, None) is True
    assert fields_agree(FieldType.NUMBER, None, 0) is False


def test_free_text_normalizes_whitespace_but_not_fuzzy():
    assert fields_agree(FieldType.LONG_TEXT, "  Hello   world  ", "Hello world") is True
    assert fields_agree(FieldType.SHORT_TEXT, "Hello", "hello") is False
    assert fields_agree(FieldType.LONG_TEXT, "Similar", "Roughly similar") is False


def test_unhandled_field_type_raises_rather_than_silently_defaulting():
    with pytest.raises(NotImplementedError):
        fields_agree("not_a_real_field_type", "x", "x")  # type: ignore[arg-type]


def test_compare_answers_all_agree_across_mixed_field_types():
    fields = [
        make_field(FieldType.SINGLE_SELECT, stable_key="outcome"),
        make_field(FieldType.CHECKBOX, stable_key="peer_reviewed"),
        make_field(FieldType.NUMBER, stable_key="n"),
    ]
    result = compare_answers(
        fields,
        {"outcome": "Positive", "peer_reviewed": True, "n": 10},
        {"outcome": "Positive", "peer_reviewed": True, "n": "10"},
    )
    assert result.all_agree is True
    assert result.disagreeing_keys == []


def test_compare_answers_reports_only_disagreeing_keys():
    fields = [
        make_field(FieldType.SINGLE_SELECT, stable_key="outcome"),
        make_field(FieldType.NUMBER, stable_key="n"),
    ]
    result = compare_answers(
        fields,
        {"outcome": "Positive", "n": 10},
        {"outcome": "Negative", "n": 10},
    )
    assert result.all_agree is False
    assert result.disagreeing_keys == ["outcome"]


def test_compare_answers_field_present_on_only_one_side_disagrees():
    """Simulates form-version drift: a field one response's form version
    doesn't have at all is treated as missing on that side and forced to
    disagreement rather than auto-agreeing on an absent value."""
    fields = [make_field(FieldType.SINGLE_SELECT, stable_key="outcome")]
    result = compare_answers(fields, {"outcome": "Positive"}, {})
    assert result.all_agree is False
    assert result.disagreeing_keys == ["outcome"]


# ---------------------------------------------------------------------------
# Dual-extraction fixture + backend integration tests
# ---------------------------------------------------------------------------


def setup_dual_extraction(db, *, extra_reviewers: int = 0, publication_count: int = 1):
    """A single-publication project by default: with claim mode and exactly
    two eligible reviewers, this guarantees both slots of the (only)
    publication are the two available items, so tests can submit/claim
    without needing to steer around unrelated publications' slots. Pass
    publication_count=2+ only for tests that specifically exercise
    cross-publication behavior (e.g. distinct-reviewer-per-publication
    guarantees)."""
    create_user(db, "admin", "Admin", "secret-password", is_admin=True)
    r1 = create_user(db, "r1", "R1", "password-1")
    r2 = create_user(db, "r2", "R2", "password-2")
    reviewers = [r1, r2]
    for index in range(extra_reviewers):
        reviewers.append(
            create_user(db, f"r{3 + index}", f"R{3 + index}", f"password-{3 + index}")
        )
    project = Project(
        name="Dual Review",
        review_type=ReviewType.SYSTEMATIC_REVIEW,
        random_seed="seed",
        stage=ProjectStage.FULL_TEXT,
    )
    db.add(project)
    db.flush()
    for reviewer in reviewers:
        db.add(
            ProjectMembership(
                project_id=project.id, user_id=reviewer.id, can_extract=True
            )
        )
    db.add(ExtractionConfig(project_id=project.id, required_reviewers=2))
    form = create_form(db, "Extraction", FormKind.EXTRACTION, project_id=project.id)
    fields = {
        "summary": add_field(db, form, "Summary", "long_text", required=True),
        "outcome": add_field(
            db,
            form,
            "Outcome",
            "single_select",
            required=True,
            options=["Positive", "Negative"],
        ),
        "themes": add_field(
            db,
            form,
            "Themes",
            "multiple_select",
            required=False,
            options=["A", "B", "C"],
        ),
        "n": add_field(db, form, "Sample size", "number", required=False),
    }
    publications = [
        Publication(project_id=project.id, title=f"Paper {i}")
        for i in range(publication_count)
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
    project.stage = ProjectStage.EXTRACTION
    db.commit()
    return project, form, fields, publications, reviewers


def agreeing_answers(fields):
    return {
        fields["summary"].stable_key: "A consistent summary",
        fields["outcome"].stable_key: "Positive",
        fields["themes"].stable_key: ["A", "B"],
        fields["n"].stable_key: 42,
    }


def submit_both_slots(db, project, publication, fields, r1, r2, answers_a, answers_b):
    item_a = claim_next_extraction(db, project.id, r1.id)
    assert item_a is not None
    submit_extraction(db, item_a, r1.id, answers_a)
    item_b = claim_next_extraction(db, project.id, r2.id)
    assert item_b is not None
    submit_extraction(db, item_b, r2.id, answers_b)
    db.commit()
    return item_a, item_b


# --- config validation -----------------------------------------------------


def test_required_reviewers_defaults_to_one(db):
    project = Project(
        name="P", review_type=ReviewType.SYSTEMATIC_REVIEW, random_seed="seed"
    )
    db.add(project)
    db.flush()
    assert extraction_required_reviewers(db, project.id) == 1


def test_update_extraction_config_rejects_out_of_range_values(db):
    project = Project(
        name="P", review_type=ReviewType.SYSTEMATIC_REVIEW, random_seed="seed"
    )
    db.add(project)
    db.flush()
    with pytest.raises(DomainError):
        update_extraction_config(
            db, project.id, allocation_mode=TaskAllocationMode.CLAIM, required_reviewers=3
        )
    with pytest.raises(DomainError):
        update_extraction_config(
            db, project.id, allocation_mode=TaskAllocationMode.CLAIM, required_reviewers=0
        )


def test_update_extraction_config_blocks_change_after_responses_exist(db):
    project, _form, fields, publications, reviewers = setup_dual_extraction(db)
    r1, r2 = reviewers[0], reviewers[1]
    initialize_extraction(db, project)
    db.commit()
    submit_both_slots(
        db,
        project,
        publications[0],
        fields,
        r1,
        r2,
        agreeing_answers(fields),
        agreeing_answers(fields),
    )
    with pytest.raises(DomainError):
        update_extraction_config(
            db, project.id, allocation_mode=TaskAllocationMode.CLAIM, required_reviewers=1
        )


def test_update_extraction_config_allows_change_before_any_response(db):
    project, _form, _fields, _publications, _reviewers = setup_dual_extraction(db)
    config = update_extraction_config(
        db, project.id, allocation_mode=TaskAllocationMode.CLAIM, required_reviewers=1
    )
    assert config.required_reviewers == 1


# --- dual init ---------------------------------------------------------


def test_dual_init_creates_two_slots_per_included_publication(db):
    project, _form, _fields, publications, _reviewers = setup_dual_extraction(
        db, publication_count=2
    )
    created = initialize_extraction(db, project)
    db.commit()
    assert created == 4  # 2 publications x 2 slots
    for publication in publications:
        items = list(
            db.scalars(
                select(ExtractionWorkItem)
                .where(ExtractionWorkItem.publication_id == publication.id)
                .order_by(ExtractionWorkItem.slot_number)
            )
        )
        assert [item.slot_number for item in items] == [1, 2]


def test_dual_init_requires_at_least_two_eligible_reviewers(db):
    create_user(db, "admin", "Admin", "secret-password", is_admin=False)
    r1 = create_user(db, "r1", "R1", "password-1")
    project = Project(
        name="P",
        review_type=ReviewType.SYSTEMATIC_REVIEW,
        random_seed="seed",
        # Stay at FULL_TEXT while recording the decision below, matching
        # setup_dual_extraction, so record_final_decision's late-inclusion
        # backfill doesn't call initialize_extraction itself before this
        # test gets to assert on it explicitly.
        stage=ProjectStage.FULL_TEXT,
    )
    db.add(project)
    db.flush()
    db.add(
        ProjectMembership(project_id=project.id, user_id=r1.id, can_extract=True)
    )
    db.add(ExtractionConfig(project_id=project.id, required_reviewers=2))
    form = create_form(db, "Extraction", FormKind.EXTRACTION, project_id=project.id)
    add_field(db, form, "Summary", "long_text", required=True)
    publication = Publication(project_id=project.id, title="Paper")
    db.add(publication)
    db.flush()
    record_final_decision(
        db, publication.id, ScreeningStage.FULL_TEXT, "include", "agreement", None, None
    )
    project.stage = ProjectStage.EXTRACTION
    db.commit()
    with pytest.raises(DomainError):
        initialize_extraction(db, project)


def test_pre_assigned_dual_mode_assigns_distinct_reviewers_per_publication(db):
    project, _form, _fields, publications, reviewers = setup_dual_extraction(
        db, publication_count=2
    )
    config = db.scalar(
        select(ExtractionConfig).where(ExtractionConfig.project_id == project.id)
    )
    config.allocation_mode = TaskAllocationMode.PRE_ASSIGNED
    db.commit()
    initialize_extraction(db, project)
    db.commit()
    for publication in publications:
        assignees = list(
            db.scalars(
                select(ExtractionWorkItem.assigned_reviewer_id)
                .where(ExtractionWorkItem.publication_id == publication.id)
                .order_by(ExtractionWorkItem.slot_number)
            )
        )
        assert len(assignees) == 2
        assert assignees[0] != assignees[1]
        assert None not in assignees


def test_claim_mode_prevents_one_reviewer_from_claiming_both_slots(db):
    # A single publication with exactly two slots: once r1 holds one slot,
    # the only other claimable item is its sibling -- which the exclusion
    # must rule out, leaving nothing left for r1 to claim.
    project, _form, _fields, publications, reviewers = setup_dual_extraction(db)
    r1 = reviewers[0]
    initialize_extraction(db, project)
    db.commit()
    first = claim_next_extraction(db, project.id, r1.id)
    assert first is not None
    db.commit()
    second = claim_next_extraction(db, project.id, r1.id, {first.id})
    assert second is None


def test_claim_mode_lets_second_reviewer_claim_the_sibling_slot(db):
    project, _form, _fields, publications, reviewers = setup_dual_extraction(db)
    r1, r2 = reviewers[0], reviewers[1]
    initialize_extraction(db, project)
    db.commit()
    first = claim_next_extraction(db, project.id, r1.id)
    assert first is not None
    db.commit()
    second = claim_next_extraction(db, project.id, r2.id)
    assert second is not None
    assert second.publication_id == first.publication_id
    assert second.id != first.id


# --- blinding ------------------------------------------------------------


def test_reviewer_blind_to_sibling_until_own_slot_completed(db):
    project, _form, fields, publications, reviewers = setup_dual_extraction(db)
    r1, r2 = reviewers[0], reviewers[1]
    initialize_extraction(db, project)
    db.commit()
    item_a = claim_next_extraction(db, project.id, r1.id)
    item_b = claim_next_extraction(db, project.id, r2.id)
    assert item_a is not None and item_b is not None
    assert item_a.publication_id == item_b.publication_id

    submit_extraction(db, item_b, r2.id, agreeing_answers(fields))
    db.commit()

    # r1's own slot is still open -- may not see r2's completed sibling yet.
    assert slot_responses_visible(db, item_a, r1.id) is False

    submit_extraction(db, item_a, r1.id, agreeing_answers(fields))
    db.commit()

    # Now that r1's own slot is complete, blinding lifts for r1.
    assert slot_responses_visible(db, item_a, r1.id) is True


def test_single_reviewer_mode_never_blinds(db):
    create_user(db, "admin", "Admin", "secret-password", is_admin=True)
    r1 = create_user(db, "r1", "R1", "password-1")
    project = Project(
        name="P",
        review_type=ReviewType.SYSTEMATIC_REVIEW,
        random_seed="seed",
        stage=ProjectStage.EXTRACTION,
    )
    db.add(project)
    db.flush()
    db.add(ProjectMembership(project_id=project.id, user_id=r1.id, can_extract=True))
    form = create_form(db, "Extraction", FormKind.EXTRACTION, project_id=project.id)
    add_field(db, form, "Summary", "long_text", required=True)
    publication = Publication(project_id=project.id, title="Paper")
    db.add(publication)
    db.flush()
    record_final_decision(
        db, publication.id, ScreeningStage.FULL_TEXT, "include", "agreement", None, None
    )
    db.commit()
    initialize_extraction(db, project)
    db.commit()
    item = claim_next_extraction(db, project.id, r1.id)
    assert item is not None
    assert slot_responses_visible(db, item, r1.id) is True


# --- auto-finalization -----------------------------------------------------


def test_agreeing_dual_responses_auto_finalize(db):
    project, _form, fields, publications, reviewers = setup_dual_extraction(db)
    r1, r2 = reviewers[0], reviewers[1]
    initialize_extraction(db, project)
    db.commit()
    submit_both_slots(
        db,
        project,
        publications[0],
        fields,
        r1,
        r2,
        agreeing_answers(fields),
        agreeing_answers(fields),
    )
    final = get_current_final_extraction(db, publications[0].id)
    assert final is not None
    assert final.resolution_method == "agreement"
    assert len(final.contributing_response_ids) == 2
    assert all(
        entry["from"] == "agreed" for entry in final.field_provenance.values()
    )
    assert reconciliation_queue(db, project.id) == []
    audit = db.scalar(
        select(AuditEvent).where(AuditEvent.action == "extraction.auto_finalized")
    )
    assert audit is not None


def test_disagreeing_dual_responses_enter_reconciliation_queue(db):
    project, _form, fields, publications, reviewers = setup_dual_extraction(db)
    r1, r2 = reviewers[0], reviewers[1]
    initialize_extraction(db, project)
    db.commit()
    answers_a = agreeing_answers(fields)
    answers_b = dict(answers_a)
    answers_b[fields["outcome"].stable_key] = "Negative"
    submit_both_slots(
        db, project, publications[0], fields, r1, r2, answers_a, answers_b
    )
    assert get_current_final_extraction(db, publications[0].id) is None
    queue = reconciliation_queue(db, project.id)
    assert [p.id for p in queue] == [publications[0].id]
    audit = db.scalar(
        select(AuditEvent).where(
            AuditEvent.action == "extraction.reconciliation_required"
        )
    )
    assert audit is not None
    assert audit.event_metadata["disagreeingFields"] == [fields["outcome"].stable_key]


def test_form_version_drift_forces_missing_field_to_disagreement(db):
    project, form, fields, publications, reviewers = setup_dual_extraction(db)
    r1, r2 = reviewers[0], reviewers[1]
    initialize_extraction(db, project)
    db.commit()
    item_a = claim_next_extraction(db, project.id, r1.id)
    item_b = claim_next_extraction(db, project.id, r2.id)
    assert item_a is not None and item_b is not None
    answers = agreeing_answers(fields)
    submit_extraction(db, item_a, r1.id, answers)
    db.commit()
    # Add a new field to the form after A already submitted, then B submits
    # against the now-newer active form version (with an answer for the new
    # field that A's response never had a chance to provide).
    new_field = add_field(db, form, "New field", "short_text", required=False)
    answers_b = dict(answers)
    answers_b[new_field.stable_key] = "only on B"
    submit_extraction(db, item_b, r2.id, answers_b)
    db.commit()

    assert get_current_final_extraction(db, publications[0].id) is None
    detail_publication, detail_fields, comparison = reconciliation_detail(
        db, publications[0].id
    )
    assert new_field.stable_key in comparison.disagreeing_keys


# --- reconciliation submission ---------------------------------------------


def test_submit_reconciliation_resolves_disagreement_with_mixed_choices(db):
    project, _form, fields, publications, reviewers = setup_dual_extraction(db)
    r1, r2 = reviewers[0], reviewers[1]
    admin_user = db.scalar(select(User).where(User.username == "admin"))
    initialize_extraction(db, project)
    db.commit()
    answers_r1 = agreeing_answers(fields)
    answers_r2 = dict(answers_r1)
    answers_r2[fields["outcome"].stable_key] = "Negative"
    answers_r2[fields["summary"].stable_key] = "A different summary"
    item_r1, item_r2 = submit_both_slots(
        db, project, publications[0], fields, r1, r2, answers_r1, answers_r2
    )
    # Which submission ends up as reconciliation's "response_a" is defined by
    # slot_number, not by claim order/reviewer identity -- read it back
    # rather than assuming r1 always lands on slot 1.
    slot1_answers = answers_r1 if item_r1.slot_number == 1 else answers_r2

    final = submit_reconciliation(
        db,
        publications[0].id,
        admin_user.id,
        {
            fields["outcome"].stable_key: {"choice": "response_a"},
            fields["summary"].stable_key: {
                "choice": "manual",
                "value": "A reconciled summary",
            },
        },
        "Resolved via source PDF review",
    )
    db.commit()
    assert final.resolution_method == "reconciliation"
    assert (
        final.answers[fields["outcome"].stable_key]
        == slot1_answers[fields["outcome"].stable_key]
    )
    assert final.answers[fields["summary"].stable_key] == "A reconciled summary"
    assert final.field_provenance[fields["outcome"].stable_key]["from"] == "response_a"
    assert final.field_provenance[fields["summary"].stable_key] == {
        "from": "manual",
        "responseId": None,
    }
    # An agreeing field is prepopulated/agreed, not left for the resolver.
    assert final.field_provenance[fields["themes"].stable_key]["from"] == "agreed"
    assert reconciliation_queue(db, project.id) == []
    audit = db.scalar(
        select(AuditEvent).where(
            AuditEvent.action == "extraction.reconciliation_completed"
        )
    )
    assert audit is not None


def test_submit_reconciliation_requires_a_note(db):
    project, _form, fields, publications, reviewers = setup_dual_extraction(db)
    r1, r2 = reviewers[0], reviewers[1]
    admin_user = db.scalar(select(User).where(User.username == "admin"))
    initialize_extraction(db, project)
    db.commit()
    answers_a = agreeing_answers(fields)
    answers_b = dict(answers_a)
    answers_b[fields["outcome"].stable_key] = "Negative"
    submit_both_slots(
        db, project, publications[0], fields, r1, r2, answers_a, answers_b
    )
    with pytest.raises(DomainError):
        submit_reconciliation(
            db,
            publications[0].id,
            admin_user.id,
            {fields["outcome"].stable_key: {"choice": "response_a"}},
            "",
        )


def test_submit_reconciliation_validates_manual_value_against_form_rules(db):
    project, _form, fields, publications, reviewers = setup_dual_extraction(db)
    r1, r2 = reviewers[0], reviewers[1]
    admin_user = db.scalar(select(User).where(User.username == "admin"))
    initialize_extraction(db, project)
    db.commit()
    answers_a = agreeing_answers(fields)
    answers_b = dict(answers_a)
    answers_b[fields["outcome"].stable_key] = "Negative"
    submit_both_slots(
        db, project, publications[0], fields, r1, r2, answers_a, answers_b
    )
    with pytest.raises(DomainError):
        submit_reconciliation(
            db,
            publications[0].id,
            admin_user.id,
            {
                fields["outcome"].stable_key: {
                    "choice": "manual",
                    "value": "Not a valid option",
                }
            },
            "note",
        )


# --- revision handling -------------------------------------------------


def test_reviewer_revision_after_agreement_invalidates_and_recomputes(db):
    project, _form, fields, publications, reviewers = setup_dual_extraction(db)
    r1, r2 = reviewers[0], reviewers[1]
    initialize_extraction(db, project)
    db.commit()
    item_a, item_b = submit_both_slots(
        db,
        project,
        publications[0],
        fields,
        r1,
        r2,
        agreeing_answers(fields),
        agreeing_answers(fields),
    )
    first_final = get_current_final_extraction(db, publications[0].id)
    assert first_final is not None

    # r1 revises but the value still matches r2's -- should re-agree with a
    # fresh FinalExtraction, and the old one preserved as invalidated history.
    submit_extraction(db, item_a, r1.id, agreeing_answers(fields))
    db.commit()

    db.refresh(first_final)
    assert first_final.is_valid is False
    assert first_final.invalidation_reason == "reviewer_revision"
    new_final = get_current_final_extraction(db, publications[0].id)
    assert new_final is not None
    assert new_final.id != first_final.id
    assert new_final.resolution_method == "agreement"


def test_reviewer_revision_can_reopen_reconciliation(db):
    project, _form, fields, publications, reviewers = setup_dual_extraction(db)
    r1, r2 = reviewers[0], reviewers[1]
    initialize_extraction(db, project)
    db.commit()
    item_a, item_b = submit_both_slots(
        db,
        project,
        publications[0],
        fields,
        r1,
        r2,
        agreeing_answers(fields),
        agreeing_answers(fields),
    )
    first_final = get_current_final_extraction(db, publications[0].id)
    assert first_final is not None

    revised = dict(agreeing_answers(fields))
    revised[fields["outcome"].stable_key] = "Negative"
    submit_extraction(db, item_a, r1.id, revised)
    db.commit()

    assert get_current_final_extraction(db, publications[0].id) is None
    db.refresh(first_final)
    assert first_final.is_valid is False
    queue = reconciliation_queue(db, project.id)
    assert [p.id for p in queue] == [publications[0].id]


# --- override (dual mode) -----------------------------------------------


def test_manager_override_writes_authoritative_final_and_invalidates_prior(db):
    project, _form, fields, publications, reviewers = setup_dual_extraction(db)
    r1, r2 = reviewers[0], reviewers[1]
    admin_user = db.scalar(select(User).where(User.username == "admin"))
    initialize_extraction(db, project)
    db.commit()
    item_a, item_b = submit_both_slots(
        db,
        project,
        publications[0],
        fields,
        r1,
        r2,
        agreeing_answers(fields),
        agreeing_answers(fields),
    )
    prior_final = get_current_final_extraction(db, publications[0].id)
    assert prior_final is not None

    overridden = dict(agreeing_answers(fields))
    overridden[fields["outcome"].stable_key] = "Negative"
    override_extraction(
        db, item_a, admin_user.id, overridden, "Corrected against source"
    )
    db.commit()

    db.refresh(prior_final)
    assert prior_final.is_valid is False
    new_final = get_current_final_extraction(db, publications[0].id)
    assert new_final is not None
    assert new_final.resolution_method == "override"
    assert new_final.answers[fields["outcome"].stable_key] == "Negative"
    assert new_final.note == "Corrected against source"
    assert all(
        entry == {"from": "manual", "responseId": None}
        for entry in new_final.field_provenance.values()
    )


# --- backward compatibility (single-reviewer mode) --------------------


def test_single_reviewer_mode_is_immediately_authoritative_never_reconciles(db):
    create_user(db, "admin", "Admin", "secret-password", is_admin=True)
    r1 = create_user(db, "r1", "R1", "password-1")
    project = Project(
        name="Single Review",
        review_type=ReviewType.SYSTEMATIC_REVIEW,
        random_seed="seed",
        stage=ProjectStage.EXTRACTION,
    )
    db.add(project)
    db.flush()
    db.add(ProjectMembership(project_id=project.id, user_id=r1.id, can_extract=True))
    form = create_form(db, "Extraction", FormKind.EXTRACTION, project_id=project.id)
    field = add_field(db, form, "Summary", "long_text", required=True)
    publication = Publication(project_id=project.id, title="Paper")
    db.add(publication)
    db.flush()
    record_final_decision(
        db, publication.id, ScreeningStage.FULL_TEXT, "include", "agreement", None, None
    )
    db.commit()
    assert extraction_required_reviewers(db, project.id) == 1
    initialize_extraction(db, project)
    db.commit()
    item = claim_next_extraction(db, project.id, r1.id)
    assert item is not None
    submit_extraction(db, item, r1.id, {field.stable_key: "Finding"})
    db.commit()

    final = get_current_final_extraction(db, publication.id)
    assert final is not None
    assert final.resolution_method == "single_reviewer"
    assert reconciliation_queue(db, project.id) == []
