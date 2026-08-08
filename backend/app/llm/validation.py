from __future__ import annotations

from datetime import date
from typing import Any, Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from app.api.errors import DomainError
from app.llm.models import LlmSchemaField, SuggestionStatus


class EvidenceItem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    page: int = Field(ge=1)
    quote: str = Field(min_length=1)
    section: str | None = Field(default=None, max_length=300)


class FieldResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    value: Any | None
    status: Literal["explicit", "inferred", "ambiguous", "not_found", "not_applicable"]
    evidence: list[EvidenceItem]


class ExtractionResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    fields: dict[str, FieldResult]


def _validate_value(field: LlmSchemaField, value: Any | None, status: str) -> None:
    if status in {SuggestionStatus.NOT_FOUND, SuggestionStatus.NOT_APPLICABLE}:
        if value is not None:
            raise DomainError(
                f"{field.label}: missing/not-applicable results must use null"
            )
        return
    if status == SuggestionStatus.INFERRED and not field.allow_inferred:
        raise DomainError(f"{field.label}: inferred values are not allowed")
    expected = field.field_type
    valid = True
    if expected in {"short_text", "long_text", "date", "url", "single_select"}:
        valid = isinstance(value, str)
    elif expected in {"number", "rating"}:
        valid = isinstance(value, (int, float)) and not isinstance(value, bool)
    elif expected == "checkbox":
        valid = isinstance(value, bool)
    elif expected == "multiple_select":
        valid = isinstance(value, list) and all(isinstance(item, str) for item in value)
    if not valid:
        raise DomainError(f"{field.label}: result has the wrong value type")
    if expected == "single_select" and field.options and value not in field.options:
        raise DomainError(f"{field.label}: result is not an allowed option")
    if expected == "date" and isinstance(value, str):
        try:
            date.fromisoformat(value)
        except ValueError as exc:
            raise DomainError(f"{field.label}: result is not an ISO date") from exc
    if expected == "url" and isinstance(value, str):
        parsed = urlsplit(value)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise DomainError(f"{field.label}: result is not an HTTP(S) URL")
    if (
        expected == "multiple_select"
        and field.options
        and isinstance(value, list)
        and any(item not in field.options for item in value)
    ):
        raise DomainError(f"{field.label}: result contains an invalid option")
    if (
        expected == "rating"
        and len(field.options) == 2
        and isinstance(value, (int, float))
    ):
        low, high = map(float, field.options)
        if not low <= float(value) <= high:
            raise DomainError(f"{field.label}: rating is outside its configured range")


def validate_result(
    payload: dict[str, Any], fields: list[LlmSchemaField]
) -> ExtractionResult:
    try:
        parsed = ExtractionResult.model_validate(payload)
    except ValidationError as exc:
        raise DomainError(f"Structured response validation failed: {exc}") from exc
    expected = {field.stable_key: field for field in fields}
    if set(parsed.fields) != set(expected):
        missing = set(expected) - set(parsed.fields)
        unknown = set(parsed.fields) - set(expected)
        raise DomainError(
            f"Structured response fields do not match the schema; missing={sorted(missing)}, "
            f"unknown={sorted(unknown)}"
        )
    for key, result in parsed.fields.items():
        _validate_value(expected[key], result.value, result.status)
    return parsed
