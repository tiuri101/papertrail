"""Pure, DB-free field-by-field comparison of two extraction answer sets.

Deliberately has no LLM involvement and no database dependency, so agreement
semantics are fully deterministic and unit-testable in isolation. Used by
app.extraction.reconciliation to decide whether two independent reviewers'
extraction responses agree closely enough to auto-finalize, or need manual
reconciliation.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from app.forms.models import FieldType, FormField

_MISSING = object()


def _normalize_missing(value: Any) -> Any:
    if value is None or value == "" or value == []:
        return _MISSING
    return value


@dataclass
class FieldComparison:
    stable_key: str
    field_type: FieldType
    value_a: Any
    value_b: Any
    agree: bool


@dataclass
class ComparisonResult:
    fields: list[FieldComparison] = field(default_factory=list)

    @property
    def all_agree(self) -> bool:
        return all(item.agree for item in self.fields)

    @property
    def disagreeing_keys(self) -> list[str]:
        return [item.stable_key for item in self.fields if not item.agree]


def _compare_single_select(value_a: Any, value_b: Any) -> bool:
    return bool(_normalize_missing(value_a) == _normalize_missing(value_b))


def _compare_checkbox(value_a: Any, value_b: Any) -> bool:
    # Missing and False are deliberately distinct states here: an unanswered
    # checkbox must not be silently treated as equivalent to an explicit
    # "false" answer, even though both are "falsy" in Python.
    norm_a = _MISSING if value_a is None else bool(value_a)
    norm_b = _MISSING if value_b is None else bool(value_b)
    return norm_a == norm_b


def _compare_multi_select(value_a: Any, value_b: Any) -> bool:
    norm_a = _normalize_missing(value_a)
    norm_b = _normalize_missing(value_b)
    if norm_a is _MISSING or norm_b is _MISSING:
        return norm_a is norm_b
    return set(norm_a) == set(norm_b)


def _coerce_numeric(value: Any) -> Any:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value)
        except ValueError:
            return value
    return value


def _compare_numeric(value_a: Any, value_b: Any) -> bool:
    norm_a = _normalize_missing(value_a)
    norm_b = _normalize_missing(value_b)
    if norm_a is _MISSING or norm_b is _MISSING:
        return norm_a is norm_b
    return bool(_coerce_numeric(norm_a) == _coerce_numeric(norm_b))


def _normalize_text(value: Any) -> Any:
    normalized = _normalize_missing(value)
    if normalized is _MISSING or not isinstance(normalized, str):
        return normalized
    return re.sub(r"\s+", " ", normalized.strip())


def _compare_text(value_a: Any, value_b: Any) -> bool:
    return bool(_normalize_text(value_a) == _normalize_text(value_b))


_COMPARATORS = {
    FieldType.SINGLE_SELECT: _compare_single_select,
    FieldType.CHECKBOX: _compare_checkbox,
    FieldType.MULTIPLE_SELECT: _compare_multi_select,
    FieldType.NUMBER: _compare_numeric,
    FieldType.RATING: _compare_numeric,
    FieldType.SHORT_TEXT: _compare_text,
    FieldType.LONG_TEXT: _compare_text,
    FieldType.DATE: _compare_text,
    FieldType.URL: _compare_text,
}


def fields_agree(field_type: FieldType, value_a: Any, value_b: Any) -> bool:
    comparator = _COMPARATORS.get(field_type)
    if comparator is None:
        raise NotImplementedError(
            f"No comparison rule defined for field type: {field_type}"
        )
    return comparator(value_a, value_b)


def compare_answers(
    fields: list[FormField],
    answers_a: dict[str, Any],
    answers_b: dict[str, Any],
) -> ComparisonResult:
    """Compare two answer sets over the union of the given fields' keys.

    A field present in `fields` but absent from one side's answers is
    normalized to "missing" on that side and always forced to disagreement
    if it's missing on exactly one side -- this covers the form-version-drift
    edge case where the two responses were completed against slightly
    different field sets.
    """
    result = ComparisonResult()
    for form_field in fields:
        key = form_field.stable_key
        has_a = key in answers_a
        has_b = key in answers_b
        value_a = answers_a.get(key)
        value_b = answers_b.get(key)
        agree = (
            False
            if has_a != has_b
            else fields_agree(form_field.field_type, value_a, value_b)
        )
        result.fields.append(
            FieldComparison(
                stable_key=key,
                field_type=form_field.field_type,
                value_a=value_a,
                value_b=value_b,
                agree=agree,
            )
        )
    return result
