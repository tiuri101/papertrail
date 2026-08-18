"""Anonymized reviewer-agreement analysis for title/abstract and full-text
screening decisions. Only ever compares the originally-configured required
reviewer slots (ScreeningWorkItem.is_additional_slot == False) -- never a
conflict-resolution tie-break slot, and never a FinalDecision consensus/
override outcome, which is a resolution result, not an independent decision.

All math lives in app.analysis.reviewer_stats (pure, DB-free, unit-tested
directly with hand-calculable fixtures); this module is purely the SQLAlchemy
orchestration that assembles the inputs those functions need.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from itertools import combinations

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.analysis.reviewer_stats import (
    ConfusionMatrix,
    FleissResult,
    cohens_kappa,
    confusion_matrix,
    fleiss_kappa,
    pseudonymize,
    raw_agreement_rate,
)
from app.conflicts.models import FinalDecision
from app.projects.models import Criterion, Project
from app.projects.models import ScreeningStage as ProjectScreeningStage
from app.screening.models import ScreeningDecision, ScreeningOutcome, ScreeningWorkItem


@dataclass
class PublicationDecisionSet:
    publication_id: str
    # reviewer_id -> that reviewer's current decision for their original slot
    decisions: dict[str, ScreeningDecision]

    @property
    def completed_at(self) -> datetime:
        return max(decision.created_at for decision in self.decisions.values())


def _pseudonym_salt(db: Session, project_id: str) -> str:
    # Reuses the project's existing random_seed (already the deterministic
    # per-project salt this codebase hashes claim ordering with, e.g.
    # screening/service.py: rank_for, extraction/service.py's random_rank)
    # rather than introducing a new secret -- the pseudonym hash only needs
    # to be unguessable of the underlying id, not cryptographically
    # independent from other uses of the same seed.
    project = db.get(Project, project_id)
    return project.random_seed if project else project_id


def _gather_complete_publication_sets(
    db: Session, project_id: str, stage: ProjectScreeningStage
) -> list[PublicationDecisionSet]:
    items = list(
        db.scalars(
            select(ScreeningWorkItem).where(
                ScreeningWorkItem.project_id == project_id,
                ScreeningWorkItem.stage == stage,
                ScreeningWorkItem.is_additional_slot.is_(False),
            )
        )
    )
    by_publication: dict[str, list[ScreeningWorkItem]] = defaultdict(list)
    for item in items:
        by_publication[item.publication_id].append(item)

    work_item_ids = [item.id for item in items]
    decisions_by_work_item: dict[str, ScreeningDecision] = {}
    if work_item_ids:
        for decision in db.scalars(
            select(ScreeningDecision).where(
                ScreeningDecision.work_item_id.in_(work_item_ids),
                ScreeningDecision.is_current.is_(True),
            )
        ):
            decisions_by_work_item[decision.work_item_id] = decision

    sets: list[PublicationDecisionSet] = []
    for publication_id, pub_items in by_publication.items():
        decisions: dict[str, ScreeningDecision] = {}
        complete = True
        for item in pub_items:
            matched_decision = decisions_by_work_item.get(item.id)
            if matched_decision is None:
                complete = False
                break
            decisions[matched_decision.reviewer_id] = matched_decision
        if complete and decisions:
            sets.append(
                PublicationDecisionSet(publication_id=publication_id, decisions=decisions)
            )
    return sets


def _final_decision_by_publication(
    db: Session, project_id: str, stage: ProjectScreeningStage, publication_ids: list[str]
) -> dict[str, FinalDecision]:
    if not publication_ids:
        return {}
    rows = db.scalars(
        select(FinalDecision).where(
            FinalDecision.project_id == project_id,
            FinalDecision.stage == stage,
            FinalDecision.is_valid.is_(True),
            FinalDecision.publication_id.in_(publication_ids),
        )
    )
    return {row.publication_id: row for row in rows}


def _all_reviewer_ids(sets: list[PublicationDecisionSet]) -> list[str]:
    ids: set[str] = set()
    for pub_set in sets:
        ids.update(pub_set.decisions)
    return sorted(ids)


def _pairwise_values(
    sets: list[PublicationDecisionSet], reviewer_a: str, reviewer_b: str
) -> list[tuple[str, str]]:
    pairs = []
    for pub_set in sets:
        if reviewer_a in pub_set.decisions and reviewer_b in pub_set.decisions:
            pairs.append(
                (
                    str(pub_set.decisions[reviewer_a].outcome.value),
                    str(pub_set.decisions[reviewer_b].outcome.value),
                )
            )
    return pairs


def _all_flattened_pairs(sets: list[PublicationDecisionSet]) -> list[tuple[str, str]]:
    flattened: list[tuple[str, str]] = []
    for pub_set in sets:
        reviewer_ids = sorted(pub_set.decisions)
        for a, b in combinations(reviewer_ids, 2):
            flattened.append(
                (
                    str(pub_set.decisions[a].outcome.value),
                    str(pub_set.decisions[b].outcome.value),
                )
            )
    return flattened


def compute_reviewer_analysis(
    db: Session, project_id: str, stage: ProjectScreeningStage
) -> dict[str, object]:
    sets = _gather_complete_publication_sets(db, project_id, stage)
    reviewer_ids = _all_reviewer_ids(sets)
    pseudonyms = pseudonymize(_pseudonym_salt(db, project_id), project_id, reviewer_ids)

    total_original_decisions = sum(len(s.decisions) for s in sets)
    flattened_pairs = _all_flattened_pairs(sets)
    overall_raw_agreement = raw_agreement_rate(flattened_pairs)

    unanimous_count = sum(
        1
        for pub_set in sets
        if len({d.outcome for d in pub_set.decisions.values()}) == 1
    )
    publication_disagreement_rate = (
        1 - (unanimous_count / len(sets)) if sets else None
    )

    uncertain_count = sum(
        1
        for pub_set in sets
        for decision in pub_set.decisions.values()
        if decision.outcome == ScreeningOutcome.UNCERTAIN
    )
    uncertain_rate = (
        uncertain_count / total_original_decisions
        if total_original_decisions
        else None
    )

    publication_ids = [s.publication_id for s in sets]
    finals = _final_decision_by_publication(db, project_id, stage, publication_ids)
    non_agreement_finals = sum(
        1
        for publication_id in publication_ids
        if publication_id in finals
        and finals[publication_id].resolution_method != "agreement"
    )
    non_agreement_rate = non_agreement_finals / len(sets) if sets else None

    revised_count = sum(
        1
        for pub_set in sets
        for decision in pub_set.decisions.values()
        if decision.version > 1
    )
    revision_rate = (
        revised_count / total_original_decisions if total_original_decisions else None
    )

    # Pairwise agreement for every reviewer pair with overlapping decisions.
    pairwise: list[dict[str, object]] = []
    for reviewer_a, reviewer_b in combinations(reviewer_ids, 2):
        pairs = _pairwise_values(sets, reviewer_a, reviewer_b)
        if not pairs:
            continue
        categories = sorted({value for pair in pairs for value in pair})
        matrix = confusion_matrix(pairs, categories)
        pairwise.append(
            {
                "reviewerA": pseudonyms.label(reviewer_a),
                "reviewerB": pseudonyms.label(reviewer_b),
                "publicationsCompared": len(pairs),
                "agreeing": sum(1 for a, b in pairs if a == b),
                "rawAgreementRate": raw_agreement_rate(pairs),
                "cohensKappa": cohens_kappa(pairs, categories),
                "confusionMatrix": _matrix_payload(matrix),
            }
        )

    # Multi-reviewer Fleiss' kappa: only meaningful for publications with
    # more than two original reviewers, and only across a group that all
    # share the same rater count (Fleiss requires a uniform n per item).
    multi_reviewer = _multi_reviewer_result(sets)

    criteria_results = _criterion_level_results(db, project_id, sets)
    trend = _weekly_trend(sets)

    return {
        "stage": stage.value,
        "overall": {
            "comparingReviewerCount": len(reviewer_ids),
            "publicationsWithCompleteSet": len(sets),
            "totalOriginalDecisions": total_original_decisions,
            "rawAgreementRate": overall_raw_agreement,
            "publicationDisagreementRate": publication_disagreement_rate,
            "uncertainDecisionRate": uncertain_rate,
            "nonAgreementResolutionCount": non_agreement_finals,
            "nonAgreementResolutionRate": non_agreement_rate,
            "revisionRate": revision_rate,
        },
        "pairwise": pairwise,
        "multiReviewer": {
            "kappa": multi_reviewer.kappa,
            "unavailableReason": multi_reviewer.reason,
        },
        "criteria": criteria_results,
        "disagreementTrend": trend,
    }


def _matrix_payload(matrix: ConfusionMatrix) -> dict[str, object]:
    return {"categories": matrix.categories, "rows": matrix.to_rows()}


def _multi_reviewer_result(sets: list[PublicationDecisionSet]) -> FleissResult:
    by_size: dict[int, list[PublicationDecisionSet]] = defaultdict(list)
    for pub_set in sets:
        by_size[len(pub_set.decisions)].append(pub_set)
    eligible_sizes = [size for size in by_size if size > 2]
    if not eligible_sizes:
        return FleissResult(
            kappa=None,
            reason="No publication has more than two original reviewers",
        )
    largest_group_size = max(eligible_sizes, key=lambda size: len(by_size[size]))
    group = by_size[largest_group_size]
    categories = sorted(
        {
            str(decision.outcome.value)
            for pub_set in group
            for decision in pub_set.decisions.values()
        }
    )
    rows = []
    for pub_set in group:
        counts = dict.fromkeys(categories, 0)
        for decision in pub_set.decisions.values():
            counts[str(decision.outcome.value)] += 1
        rows.append(counts)
    return fleiss_kappa(rows, categories)


def _criterion_level_results(
    db: Session, project_id: str, sets: list[PublicationDecisionSet]
) -> list[dict[str, object]]:
    criteria = list(
        db.scalars(
            select(Criterion).where(
                Criterion.project_id == project_id, Criterion.is_active.is_(True)
            ).order_by(Criterion.position)
        )
    )
    results = []
    for criterion in criteria:
        pairs: list[tuple[str, str]] = []
        for pub_set in sets:
            reviewer_ids = sorted(pub_set.decisions)
            for a, b in combinations(reviewer_ids, 2):
                answers_a = pub_set.decisions[a].criteria_answers
                answers_b = pub_set.decisions[b].criteria_answers
                if criterion.id in answers_a and criterion.id in answers_b:
                    pairs.append((str(answers_a[criterion.id]), str(answers_b[criterion.id])))
        if not pairs:
            continue
        disagreement_count = sum(1 for a, b in pairs if a != b)
        results.append(
            {
                "criterionId": criterion.id,
                "criterionText": criterion.text,
                "comparableDecisions": len(pairs),
                "rawAgreementRate": raw_agreement_rate(pairs),
                "disagreementCount": disagreement_count,
                "kappa": cohens_kappa(pairs, ["True", "False"]),
            }
        )
    return results


def _weekly_trend(sets: list[PublicationDecisionSet]) -> list[dict[str, object]]:
    buckets: dict[date, list[PublicationDecisionSet]] = defaultdict(list)
    for pub_set in sets:
        completed = pub_set.completed_at
        week_start = completed.date() - timedelta(days=completed.weekday())
        buckets[week_start].append(pub_set)
    trend = []
    for week_start in sorted(buckets):
        bucket_sets = buckets[week_start]
        agreement_count = sum(
            1
            for pub_set in bucket_sets
            if len({d.outcome for d in pub_set.decisions.values()}) == 1
        )
        trend.append(
            {
                "bucketStart": week_start.isoformat(),
                "comparablePublications": len(bucket_sets),
                "agreementCount": agreement_count,
                "disagreementCount": len(bucket_sets) - agreement_count,
                "agreementRate": agreement_count / len(bucket_sets),
            }
        )
    return trend


def compute_reviewer_summary(db: Session, project_id: str) -> list[dict[str, object]]:
    """Anonymized per-reviewer rollup across both screening stages."""
    stage_sets = {
        stage: _gather_complete_publication_sets(db, project_id, stage)
        for stage in (
            ProjectScreeningStage.TITLE_ABSTRACT,
            ProjectScreeningStage.FULL_TEXT,
        )
    }
    reviewer_ids: set[str] = set()
    for sets in stage_sets.values():
        reviewer_ids.update(_all_reviewer_ids(sets))
    pseudonyms = pseudonymize(_pseudonym_salt(db, project_id), project_id, sorted(reviewer_ids))

    summary: dict[str, dict[str, int]] = {
        reviewer_id: {
            "original": 0,
            "revised": 0,
            "titleAbstract": 0,
            "fullText": 0,
        }
        for reviewer_id in reviewer_ids
    }
    stage_key = {
        ProjectScreeningStage.TITLE_ABSTRACT: "titleAbstract",
        ProjectScreeningStage.FULL_TEXT: "fullText",
    }
    for stage, sets in stage_sets.items():
        for pub_set in sets:
            for reviewer_id, decision in pub_set.decisions.items():
                entry = summary[reviewer_id]
                entry["original"] += 1
                entry[stage_key[stage]] += 1
                if decision.version > 1:
                    entry["revised"] += 1

    return [
        {
            "reviewer": pseudonyms.label(reviewer_id),
            "originalDecisions": counts["original"],
            "revisedDecisions": counts["revised"],
            "revisionRate": (
                counts["revised"] / counts["original"] if counts["original"] else None
            ),
            "titleAbstractCount": counts["titleAbstract"],
            "fullTextCount": counts["fullText"],
        }
        for reviewer_id, counts in sorted(
            summary.items(), key=lambda item: pseudonyms.label(item[0])
        )
    ]
