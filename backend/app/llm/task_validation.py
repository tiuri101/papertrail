from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from app.api.errors import DomainError
from app.llm.evidence import EvidenceItem
from app.projects.models import CriterionKind

ScreeningDecision = Literal["include", "exclude", "uncertain"]
ScreeningConfidence = Literal["low", "medium", "high"]


class CriterionResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    assessment: Literal["met", "not_met", "unclear"]
    explanation: str
    evidence: list[EvidenceItem] = Field(default_factory=list)


class ScreeningTaskResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    suggested_decision: Literal["include", "exclude", "uncertain"]
    confidence: Literal["low", "medium", "high"]
    criteria: dict[str, CriterionResult]
    reasoning_summary: str


@dataclass(frozen=True)
class ScreeningRecommendation:
    suggested_decision: ScreeningDecision
    confidence: ScreeningConfidence
    reasoning_summary: str


class ValidationFieldResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    assessment: Literal["supported", "contradicted", "uncertain", "not_verifiable"]
    explanation: str
    evidence: list[EvidenceItem] = Field(default_factory=list)


class ExtractionValidationResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    fields: dict[str, ValidationFieldResult]


def _parse(model: type[BaseModel], payload: dict[str, Any]) -> BaseModel:
    try:
        return model.model_validate(payload)
    except ValidationError as exc:
        raise DomainError(f"Structured response validation failed: {exc}") from exc


def derive_screening_recommendation(
    criteria: Iterable[tuple[CriterionKind | str, str]],
) -> ScreeningRecommendation:
    """Derive a consistent recommendation from criterion-level assessments."""
    values = [(CriterionKind(kind), assessment) for kind, assessment in criteria]
    has_unclear = any(assessment == "unclear" for _, assessment in values)
    excludes = any(
        (kind == CriterionKind.INCLUSION and assessment == "not_met")
        or (kind == CriterionKind.EXCLUSION and assessment == "met")
        for kind, assessment in values
    )

    if excludes:
        return ScreeningRecommendation(
            suggested_decision="exclude",
            confidence="medium" if has_unclear else "high",
            reasoning_summary=(
                "At least one eligibility criterion indicates exclusion; other criteria remain "
                "unclear."
                if has_unclear
                else "At least one eligibility criterion indicates exclusion."
            ),
        )
    if not values or has_unclear:
        return ScreeningRecommendation(
            suggested_decision="uncertain",
            confidence="low",
            reasoning_summary=(
                "One or more eligibility criteria are unclear, so the available information is "
                "insufficient for an include or exclude suggestion."
            ),
        )
    return ScreeningRecommendation(
        suggested_decision="include",
        confidence="high",
        reasoning_summary="All eligibility criteria are resolved without an exclusion signal.",
    )


def validate_screening_result(
    payload: dict[str, Any], criterion_kinds: Mapping[str, CriterionKind]
) -> ScreeningTaskResult:
    parsed = _parse(ScreeningTaskResult, payload)
    assert isinstance(parsed, ScreeningTaskResult)
    if set(parsed.criteria) != set(criterion_kinds):
        raise DomainError("Structured response criteria do not match active criteria")
    recommendation = derive_screening_recommendation(
        (criterion_kinds[criterion_id], result.assessment)
        for criterion_id, result in parsed.criteria.items()
    )
    return parsed.model_copy(
        update={
            "suggested_decision": recommendation.suggested_decision,
            "confidence": recommendation.confidence,
            "reasoning_summary": recommendation.reasoning_summary,
        }
    )


def validate_extraction_validation(
    payload: dict[str, Any], field_keys: set[str]
) -> ExtractionValidationResult:
    parsed = _parse(ExtractionValidationResult, payload)
    assert isinstance(parsed, ExtractionValidationResult)
    if set(parsed.fields) != field_keys:
        raise DomainError("Structured response fields do not match extraction fields")
    return parsed
