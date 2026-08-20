from __future__ import annotations

import hashlib
import json
from collections import Counter
from statistics import median
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.conflicts.models import FinalDecision
from app.deduplication.models import DuplicateCandidate, PublicationMerge
from app.extraction.final import get_current_final_extractions
from app.extraction.service import active_fields as extraction_active_fields
from app.extraction.service import project_form
from app.forms.models import FieldType, FormField
from app.fulltext.models import FullTextRetrieval, RetrievalStatus
from app.projects.lifecycle import included_publication_ids
from app.projects.models import Criterion, CriterionKind
from app.projects.models import ScreeningStage as ProjectScreeningStage
from app.quality.models import QualityConfig, QualityResponse, QualityWorkItem
from app.quality.service import active_fields as quality_active_fields
from app.quality.service import quality_form
from app.reporting.prisma import calculate_prisma_counts
from app.screening.models import ScreeningDecision, ScreeningOutcome, ScreeningWorkItem

OPTION_FIELD_TYPES = {
    FieldType.SINGLE_SELECT,
    FieldType.MULTIPLE_SELECT,
    FieldType.CHECKBOX,
}
NUMERIC_FIELD_TYPES = {FieldType.NUMBER, FieldType.RATING}
HISTOGRAM_BINS = 8

STAGE_DUPLICATE_REVIEW = "duplicate_review"
STAGE_TITLE_ABSTRACT = "title_abstract_screening"
STAGE_FULL_TEXT = "full_text_screening"
STAGE_EXTRACTION = "extraction_quality"
STAGE_KEYS = (
    STAGE_DUPLICATE_REVIEW,
    STAGE_TITLE_ABSTRACT,
    STAGE_FULL_TEXT,
    STAGE_EXTRACTION,
)

_OUTCOME_LABELS = {
    ScreeningOutcome.INCLUDE: "Included",
    ScreeningOutcome.EXCLUDE: "Excluded",
    ScreeningOutcome.UNCERTAIN: "Uncertain",
    ScreeningOutcome.DUPLICATE: "Marked duplicate",
}
_RETRIEVAL_LABELS = {
    RetrievalStatus.NOT_YET_SOUGHT: "Not yet sought",
    RetrievalStatus.REQUESTED: "Requested",
    RetrievalStatus.AVAILABLE: "Available",
    RetrievalStatus.NOT_FOUND: "Not found",
    RetrievalStatus.INACCESSIBLE: "Inaccessible",
}


def _numeric_stats(values: list[float]) -> dict[str, Any]:
    low = min(values)
    high = max(values)
    if low == high:
        histogram = [{"rangeStart": low, "rangeEnd": high, "count": len(values)}]
    else:
        width = (high - low) / HISTOGRAM_BINS
        counts = [0] * HISTOGRAM_BINS
        for value in values:
            index = min(int((value - low) / width), HISTOGRAM_BINS - 1)
            counts[index] += 1
        histogram = [
            {
                "rangeStart": round(low + index * width, 4),
                "rangeEnd": round(low + (index + 1) * width, 4),
                "count": count,
            }
            for index, count in enumerate(counts)
        ]
    return {
        "min": low,
        "max": high,
        "mean": round(sum(values) / len(values), 4),
        "median": median(values),
        "histogram": histogram,
    }


def _option_counts(values: list[Any], options: list[Any]) -> list[dict[str, Any]]:
    counter: Counter[str] = Counter()
    for value in values:
        items = value if isinstance(value, list) else [value]
        for item in items:
            if item is None or item == "":
                continue
            counter[str(item)] += 1
    known_order = {str(option): index for index, option in enumerate(options)}
    ranked = sorted(
        counter.items(),
        key=lambda pair: (-pair[1], known_order.get(pair[0], len(known_order))),
    )
    return [{"option": option, "count": count} for option, count in ranked]


def _field_stats(
    field: FormField,
    answers_by_publication: dict[str, dict[str, Any]],
    total_count: int,
    source: str,
) -> dict[str, Any]:
    raw_values = [
        answers.get(field.stable_key) for answers in answers_by_publication.values()
    ]
    present = [value for value in raw_values if value not in (None, "", [])]
    stats: dict[str, Any] = {
        "id": field.id,
        "stableKey": field.stable_key,
        "label": field.label,
        "fieldType": field.field_type.value,
        "source": source,
        "answeredCount": len(present),
        "totalCount": total_count,
    }
    if field.field_type in OPTION_FIELD_TYPES:
        options = field.options or (
            ["True", "False"] if field.field_type == FieldType.CHECKBOX else []
        )
        stats["optionCounts"] = _option_counts(present, options)
    elif field.field_type in NUMERIC_FIELD_TYPES:
        numeric_values = [
            float(value) for value in present if isinstance(value, (int, float))
        ]
        if numeric_values:
            stats["numericStats"] = _numeric_stats(numeric_values)
    return stats


def _current_extraction_answers(
    db: Session, project_id: str
) -> dict[str, dict[str, Any]]:
    """The authoritative answers per publication -- from FinalExtraction,
    never an individual (possibly unresolved) reviewer response."""
    publication_ids = included_publication_ids(db, project_id)
    return {
        publication_id: final.answers
        for publication_id, final in get_current_final_extractions(
            db, list(publication_ids)
        ).items()
    }


def _current_quality(
    db: Session, project_id: str
) -> tuple[dict[str, dict[str, Any]], list[float]]:
    items = {
        item.id: item.publication_id
        for item in db.scalars(
            select(QualityWorkItem).where(QualityWorkItem.project_id == project_id)
        )
    }
    answers: dict[str, dict[str, Any]] = {}
    scores: list[float] = []
    for response in db.scalars(
        select(QualityResponse).where(
            QualityResponse.work_item_id.in_(items.keys()),
            QualityResponse.is_current.is_(True),
        )
    ):
        publication_id = items.get(response.work_item_id)
        if publication_id:
            answers[publication_id] = response.answers
        if response.total_score is not None:
            scores.append(response.total_score)
    return answers, scores


def compute_extraction_stats(db: Session, project_id: str) -> dict[str, Any]:
    total_publications = len(included_publication_ids(db, project_id))

    extraction_form = project_form(db, project_id)
    extraction_fields = (
        extraction_active_fields(db, extraction_form) if extraction_form else []
    )
    extraction_answers = _current_extraction_answers(db, project_id)

    config = db.scalar(
        select(QualityConfig).where(QualityConfig.project_id == project_id)
    )
    quality_enabled = bool(config and config.enabled)
    quality_fields: list[FormField] = []
    quality_answers: dict[str, dict[str, Any]] = {}
    quality_scores: list[float] = []
    if quality_enabled:
        form = quality_form(db, project_id)
        quality_fields = quality_active_fields(db, form) if form else []
        quality_answers, quality_scores = _current_quality(db, project_id)

    fields_stats = [
        _field_stats(field, extraction_answers, total_publications, "extraction")
        for field in extraction_fields
    ] + [
        _field_stats(field, quality_answers, total_publications, "quality")
        for field in quality_fields
    ]

    return {
        "totalPublications": total_publications,
        "completedExtractions": len(extraction_answers),
        "fields": fields_stats,
        "qualityTotalScore": _numeric_stats(quality_scores) if quality_scores else None,
    }


def _duplicate_match_reason_counts(
    db: Session, project_id: str
) -> list[dict[str, Any]]:
    reason_counter: Counter[str] = Counter()
    rows = db.execute(
        select(DuplicateCandidate.match_reasons)
        .select_from(PublicationMerge)
        .join(
            DuplicateCandidate, DuplicateCandidate.id == PublicationMerge.candidate_id
        )
        .where(
            PublicationMerge.project_id == project_id,
            PublicationMerge.reversed_at.is_(None),
        )
    )
    for (reasons,) in rows:
        for reason in reasons or []:
            reason_counter[reason] += 1
    ranked = sorted(reason_counter.items(), key=lambda pair: -pair[1])
    return [{"label": label, "count": count} for label, count in ranked]


def compute_duplicate_review_stats(db: Session, project_id: str) -> dict[str, Any]:
    counts = calculate_prisma_counts(db, project_id)
    records_identified = (
        counts["recordsIdentifiedDatabases"] + counts["recordsIdentifiedOtherSources"]
    )
    return {
        "recordsIdentified": records_identified,
        "duplicatesRemoved": counts["duplicatesRemoved"],
        "uniqueRecordsRemaining": records_identified - counts["duplicatesRemoved"],
        "matchReasonCounts": _duplicate_match_reason_counts(db, project_id),
    }


def _outcome_counts(finals: list[FinalDecision]) -> list[dict[str, Any]]:
    counter = Counter(final.outcome for final in finals)
    return [
        {"label": label, "count": counter.get(outcome, 0)}
        for outcome, label in _OUTCOME_LABELS.items()
    ]


def _criterion_exclusion_counts(
    db: Session, project_id: str, stage: ProjectScreeningStage
) -> list[dict[str, Any]]:
    excluded_publication_ids = set(
        db.scalars(
            select(FinalDecision.publication_id).where(
                FinalDecision.project_id == project_id,
                FinalDecision.stage == stage,
                FinalDecision.outcome == ScreeningOutcome.EXCLUDE,
                FinalDecision.is_valid.is_(True),
            )
        )
    )
    if not excluded_publication_ids:
        return []
    criteria = {
        criterion.id: criterion
        for criterion in db.scalars(
            select(Criterion).where(
                Criterion.project_id == project_id, Criterion.is_active.is_(True)
            )
        )
    }
    work_item_ids = list(
        db.scalars(
            select(ScreeningWorkItem.id).where(
                ScreeningWorkItem.project_id == project_id,
                ScreeningWorkItem.stage == stage,
                ScreeningWorkItem.publication_id.in_(excluded_publication_ids),
            )
        )
    )
    counter: Counter[str] = Counter()
    for decision in db.scalars(
        select(ScreeningDecision).where(
            ScreeningDecision.work_item_id.in_(work_item_ids),
            ScreeningDecision.is_current.is_(True),
        )
    ):
        for criterion_id, answer in decision.criteria_answers.items():
            criterion = criteria.get(criterion_id)
            if criterion is None:
                continue
            failed = (criterion.kind == CriterionKind.EXCLUSION and answer is True) or (
                criterion.kind == CriterionKind.INCLUSION and answer is False
            )
            if failed:
                counter[criterion.text] += 1
    ranked = sorted(counter.items(), key=lambda pair: -pair[1])
    return [{"label": label, "count": count} for label, count in ranked]


def compute_title_abstract_stats(db: Session, project_id: str) -> dict[str, Any]:
    counts = calculate_prisma_counts(db, project_id)
    title_finals = list(
        db.scalars(
            select(FinalDecision).where(
                FinalDecision.project_id == project_id,
                FinalDecision.stage == ProjectScreeningStage.TITLE_ABSTRACT,
                FinalDecision.is_valid.is_(True),
            )
        )
    )
    return {
        "recordsScreened": counts["recordsScreened"],
        "recordsExcluded": counts["recordsExcluded"],
        "outcomeCounts": _outcome_counts(title_finals),
        "exclusionReasonCounts": _criterion_exclusion_counts(
            db, project_id, ProjectScreeningStage.TITLE_ABSTRACT
        ),
    }


def compute_full_text_stats(db: Session, project_id: str) -> dict[str, Any]:
    counts = calculate_prisma_counts(db, project_id)
    retrieval_counter = Counter(
        retrieval.status
        for retrieval in db.scalars(
            select(FullTextRetrieval).where(FullTextRetrieval.project_id == project_id)
        )
    )
    full_finals = list(
        db.scalars(
            select(FinalDecision).where(
                FinalDecision.project_id == project_id,
                FinalDecision.stage == ProjectScreeningStage.FULL_TEXT,
                FinalDecision.is_valid.is_(True),
            )
        )
    )
    return {
        "reportsSought": counts["reportsSought"],
        "reportsNotRetrieved": counts["reportsNotRetrieved"],
        "reportsAssessed": counts["reportsAssessed"],
        "includedPublications": counts["includedPublications"],
        "retrievalStatusCounts": [
            {"label": label, "count": retrieval_counter.get(status, 0)}
            for status, label in _RETRIEVAL_LABELS.items()
        ],
        "outcomeCounts": _outcome_counts(full_finals),
        "exclusionReasonCounts": _criterion_exclusion_counts(
            db, project_id, ProjectScreeningStage.FULL_TEXT
        ),
    }


def compute_stage_stats(db: Session, project_id: str, stage: str) -> dict[str, Any]:
    if stage == STAGE_DUPLICATE_REVIEW:
        return compute_duplicate_review_stats(db, project_id)
    if stage == STAGE_TITLE_ABSTRACT:
        return compute_title_abstract_stats(db, project_id)
    if stage == STAGE_FULL_TEXT:
        return compute_full_text_stats(db, project_id)
    if stage == STAGE_EXTRACTION:
        return compute_extraction_stats(db, project_id)
    raise ValueError(f"Unknown analysis stage: {stage}")


def compute_stats_fingerprint(stats: dict[str, Any]) -> str:
    payload = json.dumps(stats, sort_keys=True, default=str)
    return hashlib.sha256(payload.encode()).hexdigest()
