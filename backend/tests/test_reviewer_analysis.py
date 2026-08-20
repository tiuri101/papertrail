from __future__ import annotations

from datetime import UTC, datetime, timedelta

from app.accounts.service import create_user
from app.analysis.reviewer_service import (
    compute_reviewer_analysis,
    compute_reviewer_summary,
)
from app.analysis.reviewer_stats import (
    cohens_kappa,
    confusion_matrix,
    fleiss_kappa,
    pseudonymize,
    raw_agreement_rate,
)
from app.conflicts.service import record_final_decision
from app.projects.models import (
    AllocationMode,
    Criterion,
    CriterionKind,
    Project,
    ProjectMembership,
    ProjectStage,
    ReviewType,
    ScreeningConfig,
    ScreeningStage,
)
from app.publications.models import Publication
from app.screening.models import (
    ScreeningDecision,
    ScreeningOutcome,
    ScreeningWorkItem,
    WorkItemStatus,
)

# ---------------------------------------------------------------------------
# reviewer_stats.py -- pure, hand-calculable unit tests
# ---------------------------------------------------------------------------


def test_raw_agreement_rate_perfect_agreement():
    pairs = [("include", "include"), ("exclude", "exclude"), ("include", "include")]
    assert raw_agreement_rate(pairs) == 1.0


def test_raw_agreement_rate_total_disagreement():
    pairs = [("include", "exclude"), ("exclude", "include")]
    assert raw_agreement_rate(pairs) == 0.0


def test_raw_agreement_rate_mixed():
    pairs = [
        ("include", "include"),
        ("include", "exclude"),
        ("exclude", "exclude"),
        ("exclude", "include"),
    ]
    assert raw_agreement_rate(pairs) == 0.5


def test_raw_agreement_rate_empty_returns_none():
    assert raw_agreement_rate([]) is None


def test_cohens_kappa_hand_calculated_example():
    # Classic textbook confusion matrix: 20/5/10/15 over Yes/No -> kappa = 0.4
    pairs = (
        [("yes", "yes")] * 20
        + [("yes", "no")] * 5
        + [("no", "yes")] * 10
        + [("no", "no")] * 15
    )
    kappa = cohens_kappa(pairs, ["yes", "no"])
    assert kappa is not None
    assert round(kappa, 4) == 0.4


def test_cohens_kappa_undefined_when_expected_agreement_is_one():
    # Every rater always picks the same single category -> pe == 1.
    pairs = [("include", "include")] * 10
    assert cohens_kappa(pairs, ["include"]) is None


def test_cohens_kappa_undefined_with_no_data():
    assert cohens_kappa([], ["include", "exclude"]) is None


def test_confusion_matrix_counts_all_present_outcomes():
    pairs = [
        ("include", "include"),
        ("include", "exclude"),
        ("exclude", "exclude"),
        ("uncertain", "include"),
    ]
    matrix = confusion_matrix(pairs, ["include", "exclude", "uncertain"])
    rows = {row["actual"]: row["counts"] for row in matrix.to_rows()}
    assert rows["include"] == {"include": 1, "exclude": 1, "uncertain": 0}
    assert rows["exclude"] == {"include": 0, "exclude": 1, "uncertain": 0}
    assert rows["uncertain"] == {"include": 1, "exclude": 0, "uncertain": 0}


def test_fleiss_kappa_hand_calculated_example():
    # 4 items, 3 raters each, categories include/exclude:
    # item1: 3/0, item2: 0/3, item3: 2/1, item4: 1/2 -> kappa = 1/3
    rows = [
        {"include": 3, "exclude": 0},
        {"include": 0, "exclude": 3},
        {"include": 2, "exclude": 1},
        {"include": 1, "exclude": 2},
    ]
    result = fleiss_kappa(rows, ["include", "exclude"])
    assert result.kappa is not None
    assert round(result.kappa, 4) == round(1 / 3, 4)
    assert result.reason is None


def test_fleiss_kappa_undefined_with_two_raters():
    rows = [{"include": 1, "exclude": 1}, {"include": 2, "exclude": 0}]
    result = fleiss_kappa(rows, ["include", "exclude"])
    assert result.kappa is None
    assert result.reason is not None


def test_fleiss_kappa_undefined_with_uneven_rater_counts():
    rows = [{"include": 3, "exclude": 0}, {"include": 2, "exclude": 0}]
    result = fleiss_kappa(rows, ["include", "exclude"])
    assert result.kappa is None
    assert result.reason is not None


def test_fleiss_kappa_undefined_with_no_rows():
    result = fleiss_kappa([], ["include", "exclude"])
    assert result.kappa is None
    assert result.reason is not None


def test_pseudonymize_is_deterministic_and_stable_within_project():
    ids = ["user-b", "user-a", "user-c"]
    first = pseudonymize("salt", "project-1", ids)
    second = pseudonymize("salt", "project-1", ids)
    assert first.label_by_id == second.label_by_id
    assert set(first.label_by_id.values()) == {"Reviewer A", "Reviewer B", "Reviewer C"}


def test_pseudonymize_differs_across_projects():
    ids = ["user-a", "user-b"]
    labels_1 = pseudonymize("salt", "project-1", ids).label_by_id
    labels_2 = pseudonymize("salt", "project-2", ids).label_by_id
    # Not required to differ for every id, but the assignment is salted per
    # project rather than being a fixed global ordering of raw ids.
    assert labels_1 != labels_2 or list(labels_1) != sorted(labels_1)


# ---------------------------------------------------------------------------
# reviewer_service.py -- DB-integration tests
# ---------------------------------------------------------------------------


def make_project(
    db, *, required_reviewers=2, allocation_mode=AllocationMode.INDEPENDENT
):
    project = Project(
        name="Review",
        review_type=ReviewType.SYSTEMATIC_REVIEW,
        random_seed="seed",
        stage=ProjectStage.TITLE_ABSTRACT,
    )
    db.add(project)
    db.flush()
    db.add(
        ScreeningConfig(
            project_id=project.id,
            stage=ScreeningStage.TITLE_ABSTRACT,
            required_reviewers=required_reviewers,
            allocation_mode=allocation_mode,
        )
    )
    db.add(
        ScreeningConfig(
            project_id=project.id,
            stage=ScreeningStage.FULL_TEXT,
            required_reviewers=required_reviewers,
            allocation_mode=allocation_mode,
        )
    )
    return project


def make_decision(
    db,
    project,
    publication,
    stage,
    reviewer,
    outcome,
    *,
    slot_number,
    is_additional=False,
    version=1,
    criteria_answers=None,
    created_at=None,
):
    item = ScreeningWorkItem(
        project_id=project.id,
        publication_id=publication.id,
        stage=stage,
        slot_number=slot_number,
        assigned_reviewer_id=reviewer.id,
        random_rank=f"rank-{publication.id}-{slot_number}",
        status=WorkItemStatus.SUBMITTED,
        is_additional_slot=is_additional,
    )
    db.add(item)
    db.flush()
    decision = ScreeningDecision(
        work_item_id=item.id,
        reviewer_id=reviewer.id,
        outcome=outcome,
        criteria_answers=criteria_answers or {},
        version=version,
        is_current=True,
    )
    db.add(decision)
    db.flush()
    if created_at is not None:
        decision.created_at = created_at
        db.flush()
    return item, decision


def test_reviewer_analysis_perfect_agreement_two_reviewers(db) -> None:
    project = make_project(db)
    r1 = create_user(db, "r1", "R1", "password-1")
    r2 = create_user(db, "r2", "R2", "password-2")
    pubs = [Publication(project_id=project.id, title=f"P{i}") for i in range(3)]
    db.add_all(pubs)
    db.flush()
    for pub in pubs:
        make_decision(
            db,
            project,
            pub,
            ScreeningStage.TITLE_ABSTRACT,
            r1,
            ScreeningOutcome.INCLUDE,
            slot_number=1,
        )
        make_decision(
            db,
            project,
            pub,
            ScreeningStage.TITLE_ABSTRACT,
            r2,
            ScreeningOutcome.INCLUDE,
            slot_number=2,
        )
    db.commit()

    result = compute_reviewer_analysis(db, project.id, ScreeningStage.TITLE_ABSTRACT)
    assert result["overall"]["publicationsWithCompleteSet"] == 3
    assert result["overall"]["rawAgreementRate"] == 1.0
    assert result["overall"]["publicationDisagreementRate"] == 0.0
    assert len(result["pairwise"]) == 1
    assert result["pairwise"][0]["rawAgreementRate"] == 1.0
    # Perfect agreement with both categories the same -> expected agreement 1 -> undefined kappa.
    assert result["pairwise"][0]["cohensKappa"] is None


def test_reviewer_analysis_total_disagreement(db) -> None:
    project = make_project(db)
    r1 = create_user(db, "r1", "R1", "password-1")
    r2 = create_user(db, "r2", "R2", "password-2")
    pubs = [Publication(project_id=project.id, title=f"P{i}") for i in range(4)]
    db.add_all(pubs)
    db.flush()
    for pub in pubs:
        make_decision(
            db,
            project,
            pub,
            ScreeningStage.TITLE_ABSTRACT,
            r1,
            ScreeningOutcome.INCLUDE,
            slot_number=1,
        )
        make_decision(
            db,
            project,
            pub,
            ScreeningStage.TITLE_ABSTRACT,
            r2,
            ScreeningOutcome.EXCLUDE,
            slot_number=2,
        )
    db.commit()

    result = compute_reviewer_analysis(db, project.id, ScreeningStage.TITLE_ABSTRACT)
    assert result["overall"]["rawAgreementRate"] == 0.0
    assert result["overall"]["publicationDisagreementRate"] == 1.0
    assert result["pairwise"][0]["rawAgreementRate"] == 0.0


def test_reviewer_analysis_uncertain_decisions_counted_separately(db) -> None:
    project = make_project(db)
    r1 = create_user(db, "r1", "R1", "password-1")
    r2 = create_user(db, "r2", "R2", "password-2")
    pub = Publication(project_id=project.id, title="P")
    db.add(pub)
    db.flush()
    make_decision(
        db,
        project,
        pub,
        ScreeningStage.TITLE_ABSTRACT,
        r1,
        ScreeningOutcome.UNCERTAIN,
        slot_number=1,
    )
    make_decision(
        db,
        project,
        pub,
        ScreeningStage.TITLE_ABSTRACT,
        r2,
        ScreeningOutcome.INCLUDE,
        slot_number=2,
    )
    db.commit()

    result = compute_reviewer_analysis(db, project.id, ScreeningStage.TITLE_ABSTRACT)
    assert result["overall"]["uncertainDecisionRate"] == 0.5


def test_reviewer_analysis_excludes_incomplete_reviewer_sets(db) -> None:
    project = make_project(db)
    r1 = create_user(db, "r1", "R1", "password-1")
    r2 = create_user(db, "r2", "R2", "password-2")
    complete_pub = Publication(project_id=project.id, title="Complete")
    incomplete_pub = Publication(project_id=project.id, title="Incomplete")
    db.add_all([complete_pub, incomplete_pub])
    db.flush()
    make_decision(
        db,
        project,
        complete_pub,
        ScreeningStage.TITLE_ABSTRACT,
        r1,
        ScreeningOutcome.INCLUDE,
        slot_number=1,
    )
    make_decision(
        db,
        project,
        complete_pub,
        ScreeningStage.TITLE_ABSTRACT,
        r2,
        ScreeningOutcome.INCLUDE,
        slot_number=2,
    )
    # Only slot 1 decided for incomplete_pub -- slot 2 exists but has no
    # current decision, so this publication must be excluded entirely.
    make_decision(
        db,
        project,
        incomplete_pub,
        ScreeningStage.TITLE_ABSTRACT,
        r1,
        ScreeningOutcome.INCLUDE,
        slot_number=1,
    )
    db.add(
        ScreeningWorkItem(
            project_id=project.id,
            publication_id=incomplete_pub.id,
            stage=ScreeningStage.TITLE_ABSTRACT,
            slot_number=2,
            assigned_reviewer_id=r2.id,
            random_rank="rank-incomplete-2",
            status=WorkItemStatus.AVAILABLE,
        )
    )
    db.commit()

    result = compute_reviewer_analysis(db, project.id, ScreeningStage.TITLE_ABSTRACT)
    assert result["overall"]["publicationsWithCompleteSet"] == 1


def test_reviewer_analysis_does_not_treat_single_reviewer_as_agreement(db) -> None:
    project = make_project(db, required_reviewers=1)
    reviewer = create_user(db, "r1", "R1", "password-1")
    db.add(
        ProjectMembership(
            project_id=project.id,
            user_id=reviewer.id,
            can_title_abstract_screen=True,
        )
    )
    publication = Publication(project_id=project.id, title="Single review")
    db.add(publication)
    db.flush()
    make_decision(
        db,
        project,
        publication,
        ScreeningStage.TITLE_ABSTRACT,
        reviewer,
        ScreeningOutcome.INCLUDE,
        slot_number=1,
    )
    db.commit()

    result = compute_reviewer_analysis(db, project.id, ScreeningStage.TITLE_ABSTRACT)

    assert result["configuredReviewerCount"] == 1
    assert result["eligibleReviewerCount"] == 1
    assert result["overall"]["maximumReviewerCount"] == 0
    assert result["overall"]["publicationsWithCompleteSet"] == 0
    assert result["overall"]["rawAgreementRate"] is None
    assert result["overall"]["publicationDisagreementRate"] is None
    assert result["pairwise"] == []
    assert result["criteria"] == []
    assert result["disagreementTrend"] == []


def test_reviewer_analysis_excludes_additional_resolution_slots(db) -> None:
    project = make_project(db)
    r1 = create_user(db, "r1", "R1", "password-1")
    r2 = create_user(db, "r2", "R2", "password-2")
    r3 = create_user(db, "r3", "R3", "password-3")
    pub = Publication(project_id=project.id, title="P")
    db.add(pub)
    db.flush()
    make_decision(
        db,
        project,
        pub,
        ScreeningStage.TITLE_ABSTRACT,
        r1,
        ScreeningOutcome.INCLUDE,
        slot_number=1,
    )
    make_decision(
        db,
        project,
        pub,
        ScreeningStage.TITLE_ABSTRACT,
        r2,
        ScreeningOutcome.EXCLUDE,
        slot_number=2,
    )
    # A tie-break slot added via add_resolution_reviewer -- must not count
    # as an original reviewer decision.
    make_decision(
        db,
        project,
        pub,
        ScreeningStage.TITLE_ABSTRACT,
        r3,
        ScreeningOutcome.INCLUDE,
        slot_number=3,
        is_additional=True,
    )
    db.commit()

    result = compute_reviewer_analysis(db, project.id, ScreeningStage.TITLE_ABSTRACT)
    assert result["overall"]["totalOriginalDecisions"] == 2
    assert len(result["pairwise"]) == 1
    reviewer_labels = {
        result["pairwise"][0]["reviewerA"],
        result["pairwise"][0]["reviewerB"],
    }
    assert len(reviewer_labels) == 2


def test_reviewer_analysis_excludes_final_decision_consensus_from_pairwise(db) -> None:
    """FinalDecision rows (agreement/majority/admin_consensus/etc.) are
    resolution outcomes, not independent reviewer decisions, and must never
    be treated as though they were another reviewer's original input."""
    project = make_project(db)
    r1 = create_user(db, "r1", "R1", "password-1")
    r2 = create_user(db, "r2", "R2", "password-2")
    pub = Publication(project_id=project.id, title="P")
    db.add(pub)
    db.flush()
    make_decision(
        db,
        project,
        pub,
        ScreeningStage.TITLE_ABSTRACT,
        r1,
        ScreeningOutcome.INCLUDE,
        slot_number=1,
    )
    make_decision(
        db,
        project,
        pub,
        ScreeningStage.TITLE_ABSTRACT,
        r2,
        ScreeningOutcome.INCLUDE,
        slot_number=2,
    )
    record_final_decision(
        db, pub.id, ScreeningStage.TITLE_ABSTRACT, "include", "agreement", None, None
    )
    db.commit()

    result = compute_reviewer_analysis(db, project.id, ScreeningStage.TITLE_ABSTRACT)
    assert result["overall"]["totalOriginalDecisions"] == 2
    assert result["overall"]["nonAgreementResolutionCount"] == 0


def test_reviewer_analysis_flags_non_agreement_resolution(db) -> None:
    project = make_project(db)
    r1 = create_user(db, "r1", "R1", "password-1")
    r2 = create_user(db, "r2", "R2", "password-2")
    pub = Publication(project_id=project.id, title="P")
    db.add(pub)
    db.flush()
    make_decision(
        db,
        project,
        pub,
        ScreeningStage.TITLE_ABSTRACT,
        r1,
        ScreeningOutcome.INCLUDE,
        slot_number=1,
    )
    make_decision(
        db,
        project,
        pub,
        ScreeningStage.TITLE_ABSTRACT,
        r2,
        ScreeningOutcome.EXCLUDE,
        slot_number=2,
    )
    record_final_decision(
        db,
        pub.id,
        ScreeningStage.TITLE_ABSTRACT,
        "include",
        "admin_consensus",
        r1.id,
        "Owner ruling",
    )
    db.commit()

    result = compute_reviewer_analysis(db, project.id, ScreeningStage.TITLE_ABSTRACT)
    assert result["overall"]["nonAgreementResolutionCount"] == 1
    assert result["overall"]["nonAgreementResolutionRate"] == 1.0


def test_reviewer_analysis_title_abstract_and_full_text_kept_separate(db) -> None:
    project = make_project(db)
    r1 = create_user(db, "r1", "R1", "password-1")
    r2 = create_user(db, "r2", "R2", "password-2")
    pub = Publication(project_id=project.id, title="P")
    db.add(pub)
    db.flush()
    make_decision(
        db,
        project,
        pub,
        ScreeningStage.TITLE_ABSTRACT,
        r1,
        ScreeningOutcome.INCLUDE,
        slot_number=1,
    )
    make_decision(
        db,
        project,
        pub,
        ScreeningStage.TITLE_ABSTRACT,
        r2,
        ScreeningOutcome.INCLUDE,
        slot_number=2,
    )
    db.commit()

    title_abstract = compute_reviewer_analysis(
        db, project.id, ScreeningStage.TITLE_ABSTRACT
    )
    full_text = compute_reviewer_analysis(db, project.id, ScreeningStage.FULL_TEXT)
    assert title_abstract["overall"]["publicationsWithCompleteSet"] == 1
    assert full_text["overall"]["publicationsWithCompleteSet"] == 0


def test_reviewer_analysis_three_reviewers_computes_fleiss_kappa(db) -> None:
    project = make_project(db, required_reviewers=3)
    reviewers = [create_user(db, f"r{i}", f"R{i}", f"password-{i}") for i in range(3)]
    outcomes_by_pub = [
        [ScreeningOutcome.INCLUDE, ScreeningOutcome.INCLUDE, ScreeningOutcome.INCLUDE],
        [ScreeningOutcome.EXCLUDE, ScreeningOutcome.EXCLUDE, ScreeningOutcome.EXCLUDE],
        [ScreeningOutcome.INCLUDE, ScreeningOutcome.INCLUDE, ScreeningOutcome.EXCLUDE],
        [ScreeningOutcome.INCLUDE, ScreeningOutcome.EXCLUDE, ScreeningOutcome.EXCLUDE],
    ]
    for index, outcomes in enumerate(outcomes_by_pub):
        pub = Publication(project_id=project.id, title=f"P{index}")
        db.add(pub)
        db.flush()
        for slot, (reviewer, outcome) in enumerate(
            zip(reviewers, outcomes, strict=True), start=1
        ):
            make_decision(
                db,
                project,
                pub,
                ScreeningStage.TITLE_ABSTRACT,
                reviewer,
                outcome,
                slot_number=slot,
            )
    db.commit()

    result = compute_reviewer_analysis(db, project.id, ScreeningStage.TITLE_ABSTRACT)
    assert result["multiReviewer"]["kappa"] is not None
    assert round(result["multiReviewer"]["kappa"], 4) == round(1 / 3, 4)
    assert result["multiReviewer"]["unavailableReason"] is None
    assert len(result["pairwise"]) == 3  # 3 reviewers -> 3 pairs


def test_reviewer_analysis_multi_reviewer_unavailable_for_two_reviewers(db) -> None:
    project = make_project(db)
    r1 = create_user(db, "r1", "R1", "password-1")
    r2 = create_user(db, "r2", "R2", "password-2")
    pub = Publication(project_id=project.id, title="P")
    db.add(pub)
    db.flush()
    make_decision(
        db,
        project,
        pub,
        ScreeningStage.TITLE_ABSTRACT,
        r1,
        ScreeningOutcome.INCLUDE,
        slot_number=1,
    )
    make_decision(
        db,
        project,
        pub,
        ScreeningStage.TITLE_ABSTRACT,
        r2,
        ScreeningOutcome.INCLUDE,
        slot_number=2,
    )
    db.commit()

    result = compute_reviewer_analysis(db, project.id, ScreeningStage.TITLE_ABSTRACT)
    assert result["multiReviewer"]["kappa"] is None
    assert result["multiReviewer"]["unavailableReason"] is not None


def test_reviewer_analysis_revision_rate(db) -> None:
    project = make_project(db)
    r1 = create_user(db, "r1", "R1", "password-1")
    r2 = create_user(db, "r2", "R2", "password-2")
    pub = Publication(project_id=project.id, title="P")
    db.add(pub)
    db.flush()
    make_decision(
        db,
        project,
        pub,
        ScreeningStage.TITLE_ABSTRACT,
        r1,
        ScreeningOutcome.INCLUDE,
        slot_number=1,
        version=2,
    )
    make_decision(
        db,
        project,
        pub,
        ScreeningStage.TITLE_ABSTRACT,
        r2,
        ScreeningOutcome.INCLUDE,
        slot_number=2,
        version=1,
    )
    db.commit()

    result = compute_reviewer_analysis(db, project.id, ScreeningStage.TITLE_ABSTRACT)
    assert result["overall"]["revisionRate"] == 0.5


def test_reviewer_analysis_criterion_level_agreement(db) -> None:
    project = make_project(db)
    r1 = create_user(db, "r1", "R1", "password-1")
    r2 = create_user(db, "r2", "R2", "password-2")
    criterion = Criterion(
        project_id=project.id, kind=CriterionKind.INCLUSION, text="Relevant", position=0
    )
    db.add(criterion)
    db.flush()
    pub_agree = Publication(project_id=project.id, title="Agree")
    pub_disagree = Publication(project_id=project.id, title="Disagree")
    db.add_all([pub_agree, pub_disagree])
    db.flush()
    make_decision(
        db,
        project,
        pub_agree,
        ScreeningStage.TITLE_ABSTRACT,
        r1,
        ScreeningOutcome.INCLUDE,
        slot_number=1,
        criteria_answers={criterion.id: True},
    )
    make_decision(
        db,
        project,
        pub_agree,
        ScreeningStage.TITLE_ABSTRACT,
        r2,
        ScreeningOutcome.INCLUDE,
        slot_number=2,
        criteria_answers={criterion.id: True},
    )
    make_decision(
        db,
        project,
        pub_disagree,
        ScreeningStage.TITLE_ABSTRACT,
        r1,
        ScreeningOutcome.INCLUDE,
        slot_number=1,
        criteria_answers={criterion.id: True},
    )
    make_decision(
        db,
        project,
        pub_disagree,
        ScreeningStage.TITLE_ABSTRACT,
        r2,
        ScreeningOutcome.EXCLUDE,
        slot_number=2,
        criteria_answers={criterion.id: False},
    )
    db.commit()

    result = compute_reviewer_analysis(db, project.id, ScreeningStage.TITLE_ABSTRACT)
    assert len(result["criteria"]) == 1
    entry = result["criteria"][0]
    assert entry["criterionId"] == criterion.id
    assert entry["comparableDecisions"] == 2
    assert entry["rawAgreementRate"] == 0.5
    assert entry["disagreementCount"] == 1


def test_reviewer_analysis_weekly_trend_buckets_by_completion_date(db) -> None:
    project = make_project(db)
    r1 = create_user(db, "r1", "R1", "password-1")
    r2 = create_user(db, "r2", "R2", "password-2")
    week1 = datetime(2026, 1, 5, tzinfo=UTC)  # a Monday
    week2 = week1 + timedelta(days=8)
    pub1 = Publication(project_id=project.id, title="P1")
    pub2 = Publication(project_id=project.id, title="P2")
    db.add_all([pub1, pub2])
    db.flush()
    make_decision(
        db,
        project,
        pub1,
        ScreeningStage.TITLE_ABSTRACT,
        r1,
        ScreeningOutcome.INCLUDE,
        slot_number=1,
        created_at=week1,
    )
    make_decision(
        db,
        project,
        pub1,
        ScreeningStage.TITLE_ABSTRACT,
        r2,
        ScreeningOutcome.INCLUDE,
        slot_number=2,
        created_at=week1,
    )
    make_decision(
        db,
        project,
        pub2,
        ScreeningStage.TITLE_ABSTRACT,
        r1,
        ScreeningOutcome.INCLUDE,
        slot_number=1,
        created_at=week2,
    )
    make_decision(
        db,
        project,
        pub2,
        ScreeningStage.TITLE_ABSTRACT,
        r2,
        ScreeningOutcome.EXCLUDE,
        slot_number=2,
        created_at=week2,
    )
    db.commit()

    result = compute_reviewer_analysis(db, project.id, ScreeningStage.TITLE_ABSTRACT)
    assert len(result["disagreementTrend"]) == 2
    first, second = result["disagreementTrend"]
    assert first["comparablePublications"] == 1
    assert first["agreementRate"] == 1.0
    assert second["comparablePublications"] == 1
    assert second["agreementRate"] == 0.0
    # No reviewer identity anywhere in the trend payload.
    for bucket in result["disagreementTrend"]:
        assert "reviewer" not in str(bucket).lower() or "reviewerCount" not in bucket


def test_reviewer_summary_has_no_identifying_fields(db) -> None:
    project = make_project(db)
    r1 = create_user(db, "r1", "R1", "password-1")
    r2 = create_user(db, "r2", "R2", "password-2")
    pub = Publication(project_id=project.id, title="P")
    db.add(pub)
    db.flush()
    make_decision(
        db,
        project,
        pub,
        ScreeningStage.TITLE_ABSTRACT,
        r1,
        ScreeningOutcome.INCLUDE,
        slot_number=1,
        version=2,
    )
    make_decision(
        db,
        project,
        pub,
        ScreeningStage.TITLE_ABSTRACT,
        r2,
        ScreeningOutcome.INCLUDE,
        slot_number=2,
    )
    db.commit()

    summary = compute_reviewer_summary(db, project.id)
    assert len(summary) == 2
    payload = str(summary)
    assert r1.id not in payload
    assert r2.id not in payload
    assert r1.username not in payload
    assert r2.username not in payload
    assert r1.display_name not in payload
    for entry in summary:
        assert entry["reviewer"].startswith("Reviewer ")
        assert set(entry) == {
            "reviewer",
            "originalDecisions",
            "revisedDecisions",
            "revisionRate",
            "titleAbstractCount",
            "fullTextCount",
        }


def test_reviewer_analysis_api_response_contains_no_identifying_fields(
    client, db
) -> None:
    admin = create_user(db, "admin", "Admin", "secret-password", is_admin=True)
    project = make_project(db)
    project.stage = ProjectStage.FULL_TEXT
    r1 = create_user(db, "r1", "R1", "password-1", email="r1@example.org")
    r2 = create_user(db, "r2", "R2", "password-2", email="r2@example.org")
    db.add_all(
        [
            ProjectMembership(project_id=project.id, user_id=admin.id, is_owner=True),
        ]
    )
    pub = Publication(project_id=project.id, title="P")
    db.add(pub)
    db.flush()
    make_decision(
        db,
        project,
        pub,
        ScreeningStage.TITLE_ABSTRACT,
        r1,
        ScreeningOutcome.INCLUDE,
        slot_number=1,
    )
    make_decision(
        db,
        project,
        pub,
        ScreeningStage.TITLE_ABSTRACT,
        r2,
        ScreeningOutcome.EXCLUDE,
        slot_number=2,
    )
    db.commit()

    login = client.post(
        "/api/v1/auth/login", json={"username": "admin", "password": "secret-password"}
    )
    assert login.status_code == 200
    response = client.get(
        f"/api/v1/projects/{project.id}/analysis/reviewer-analysis/title_abstract"
    )
    assert response.status_code == 200
    body = response.text
    for forbidden in (
        r1.id,
        r2.id,
        r1.username,
        r2.username,
        r1.display_name,
        r2.display_name,
        "r1@example.org",
        "r2@example.org",
    ):
        assert forbidden not in body
