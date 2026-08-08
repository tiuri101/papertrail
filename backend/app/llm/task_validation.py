from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from app.api.errors import DomainError


class TaskEvidence(BaseModel):
    model_config = ConfigDict(extra="forbid")

    page: int = Field(ge=1)
    quote: str = Field(min_length=1)
    section: str | None = Field(default=None, max_length=300)


class CriterionResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    assessment: Literal["met", "not_met", "unclear"]
    explanation: str
    evidence: list[TaskEvidence] = Field(default_factory=list)


class ScreeningTaskResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    suggested_decision: Literal["include", "exclude", "uncertain"]
    confidence: Literal["low", "medium", "high"]
    criteria: dict[str, CriterionResult]
    reasoning_summary: str


class ValidationFieldResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    assessment: Literal["supported", "contradicted", "uncertain", "not_verifiable"]
    explanation: str
    evidence: list[TaskEvidence] = Field(default_factory=list)


class ExtractionValidationResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    fields: dict[str, ValidationFieldResult]


def _parse(model: type[BaseModel], payload: dict[str, Any]) -> BaseModel:
    try:
        return model.model_validate(payload)
    except ValidationError as exc:
        raise DomainError(f"Structured response validation failed: {exc}") from exc


def validate_screening_result(
    payload: dict[str, Any], criterion_ids: set[str]
) -> ScreeningTaskResult:
    parsed = _parse(ScreeningTaskResult, payload)
    assert isinstance(parsed, ScreeningTaskResult)
    if set(parsed.criteria) != criterion_ids:
        raise DomainError("Structured response criteria do not match active criteria")
    return parsed


def validate_extraction_validation(
    payload: dict[str, Any], field_keys: set[str]
) -> ExtractionValidationResult:
    parsed = _parse(ExtractionValidationResult, payload)
    assert isinstance(parsed, ExtractionValidationResult)
    if set(parsed.fields) != field_keys:
        raise DomainError("Structured response fields do not match extraction fields")
    return parsed
