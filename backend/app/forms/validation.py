"""The single authoritative FieldType-aware validation layer for dynamic forms.

Two questions are answered here, and nowhere else:

1. **Is this field *definition* well-formed?** (:func:`validate_field_definition`)
   Called on every write path that creates or changes a ``FormField``
   (``app.forms.service.add_field`` / ``update_field`` / ``replace_field``), so
   a malformed definition can never reach the database and force downstream
   code -- reviewer UI, scoring, LLM schema generation, exports -- to invent
   fallback behavior for it.

2. **Is this submitted *value* valid for that field?** (:func:`validate_answers`)
   Called by both extraction (``app.extraction.service``) and quality
   (``app.quality.service``) submission. They previously shared one function
   only because quality imported extraction's; the rule set now lives in one
   module that neither domain owns.

Two invariants are worth spelling out because they are easy to get wrong:

* **A boolean is never a number.**  ``isinstance(True, int)`` is ``True`` in
  Python, so every numeric check goes through :func:`is_number`, which excludes
  ``bool`` explicitly.  A checkbox answer that leaked into a NUMBER field --
  or into quality scoring -- would otherwise silently score as ``1``.
* **Blank is not the same as absent.**  ``normalize_answers`` fills in the
  implicit default for controls that submit nothing when left alone, so by the
  time answers reach here, "missing" and "explicitly empty" mean the same
  thing: the reviewer did not answer.  Requiredness is therefore checked once,
  uniformly, for every field type (see :func:`is_blank`) rather than per type.

``False`` is deliberately *not* blank: an unchecked checkbox is an answer
("no"), not an unanswered field, so a required checkbox is satisfied by
``False``.  Requiring ``True`` would make "no" unrecordable.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping, Sequence
from datetime import date
from typing import Any
from urllib.parse import urlsplit

from app.api.errors import DomainError
from app.forms.models import FieldType, FormField

# Types whose stored ``options`` are the allowed answers.
OPTION_FIELD_TYPES = frozenset({FieldType.SINGLE_SELECT, FieldType.MULTIPLE_SELECT})
# Types whose stored ``options`` are a two-element ``[min, max]`` scale rather
# than a list of choices (see the rating control in the reviewer UI).
SCALE_FIELD_TYPES = frozenset({FieldType.RATING})
# Types a quality form can attach scoring configuration to, and which scoring
# keys each of them understands.  Anything else must carry no scoring at all:
# ``app.quality.service.score_response`` cannot turn free text, a date, a URL
# or a multi-select into a number, so scoring on those types is configuration
# that silently does nothing.
SCORING_KEYS_BY_TYPE: dict[FieldType, frozenset[str]] = {
    FieldType.NUMBER: frozenset({"weight"}),
    FieldType.RATING: frozenset({"weight"}),
    FieldType.SINGLE_SELECT: frozenset({"weight", "values"}),
    FieldType.CHECKBOX: frozenset({"weight", "true", "false"}),
}

_ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def is_number(value: Any) -> bool:
    """Whether ``value`` is a real number -- ``bool`` excluded.

    ``isinstance(True, int)`` is ``True``, so every numeric test in the
    codebase must exclude ``bool`` first or a checkbox answer scores as 1.
    """
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def as_number(value: Any) -> float | None:
    """``value`` as a float if it is a real (non-boolean) number, else None."""
    return float(value) if is_number(value) else None


def is_blank(value: Any) -> bool:
    """Whether a submitted value means "not answered".

    ``False`` and ``0`` are answers, not blanks; an empty or whitespace-only
    string, an empty list and a missing key are not.
    """
    if value is None:
        return True
    if isinstance(value, str):
        return not value.strip()
    if isinstance(value, (list, tuple, set, dict)):
        return len(value) == 0
    return False


def parse_field_type(field_type: str | FieldType) -> FieldType:
    """The ``FieldType`` for ``field_type``, as a 400 rather than a 500.

    ``FieldType(value)`` raises ``ValueError`` for anything unrecognized,
    which would surface as an unhandled server error on the form-builder
    endpoints.
    """
    try:
        return FieldType(field_type)
    except ValueError as exc:
        allowed = ", ".join(member.value for member in FieldType)
        raise DomainError(
            f"Unknown form field type: {field_type!r}. Expected one of: {allowed}"
        ) from exc


# --------------------------------------------------------------------------
# Field definitions
# --------------------------------------------------------------------------


def _validate_options(
    field_type: FieldType, label: str, options: Sequence[Any]
) -> list[Any]:
    if field_type in OPTION_FIELD_TYPES:
        if not options:
            raise DomainError(f"At least one option is required for: {label}")
        if any(not isinstance(option, str) or not option.strip() for option in options):
            raise DomainError(f"Options must be non-empty text for: {label}")
        if len(set(options)) != len(options):
            raise DomainError(f"Options must be unique for: {label}")
        return list(options)
    if field_type in SCALE_FIELD_TYPES:
        # An unconfigured rating keeps the reviewer UI's default scale, so an
        # empty scale stays valid; a partially-specified one never does.
        if not options:
            return []
        if len(options) != 2:
            raise DomainError(
                f"A rating scale needs exactly a minimum and a maximum for: {label}"
            )
        bounds = [_scale_bound(value, label) for value in options]
        if bounds[0] >= bounds[1]:
            raise DomainError(
                f"A rating scale's minimum must be below its maximum for: {label}"
            )
        return list(options)
    if options:
        raise DomainError(f"A {field_type.value} field cannot have options: {label}")
    return []


def _scale_bound(value: Any, label: str) -> float:
    if is_number(value):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value.strip())
        except ValueError as exc:
            raise DomainError(
                f"A rating scale's bounds must be numbers for: {label}"
            ) from exc
    raise DomainError(f"A rating scale's bounds must be numbers for: {label}")


def rating_bounds(field: FormField) -> tuple[float, float] | None:
    """The configured ``(min, max)`` of a rating field, or None if unset."""
    if field.field_type not in SCALE_FIELD_TYPES or len(field.options or []) != 2:
        return None
    try:
        low, high = (_scale_bound(bound, field.label) for bound in field.options)
    except DomainError:
        # A definition stored before this module existed. Treat an
        # uninterpretable scale as unconfigured rather than rejecting an
        # otherwise-valid answer.
        return None
    return low, high


def _validate_scoring(
    field_type: FieldType,
    label: str,
    options: Sequence[Any],
    scoring: Mapping[str, Any],
) -> dict[str, Any]:
    if not scoring:
        return {}
    allowed = SCORING_KEYS_BY_TYPE.get(field_type)
    if allowed is None:
        raise DomainError(
            f"A {field_type.value} field cannot be scored, so it cannot carry "
            f"scoring configuration: {label}"
        )
    unknown = sorted(set(scoring) - allowed)
    if unknown:
        raise DomainError(
            f"Unsupported scoring settings for {field_type.value} field "
            f"'{label}': {', '.join(unknown)}"
        )
    if "weight" in scoring:
        weight = as_number(scoring["weight"])
        if weight is None or weight <= 0:
            raise DomainError(f"Scoring weight must be a positive number for: {label}")
    for key in ("true", "false"):
        if key in scoring and as_number(scoring[key]) is None:
            raise DomainError(f"Checkbox scores must be numbers for: {label}")
    if "values" in scoring:
        values = scoring["values"]
        if not isinstance(values, Mapping):
            raise DomainError(f"Option scores must be a mapping for: {label}")
        unknown_options = sorted(set(values) - set(options))
        if unknown_options:
            raise DomainError(
                f"Option scores refer to options that are not configured for "
                f"'{label}': {', '.join(unknown_options)}"
            )
        if any(as_number(score) is None for score in values.values()):
            raise DomainError(f"Option scores must be numbers for: {label}")
    return dict(scoring)


def validate_field_definition(
    field_type: str | FieldType,
    *,
    label: str,
    options: Sequence[Any] | None = None,
    scoring: Mapping[str, Any] | None = None,
) -> tuple[FieldType, list[Any], dict[str, Any]]:
    """Validate one field's configuration, returning it normalized.

    Raises :class:`DomainError` (400) rather than letting a malformed
    definition reach the database.
    """
    resolved = parse_field_type(field_type)
    if not label or not label.strip():
        raise DomainError("A form field needs a label")
    checked_options = _validate_options(resolved, label, list(options or []))
    checked_scoring = _validate_scoring(
        resolved, label, checked_options, dict(scoring or {})
    )
    return resolved, checked_options, checked_scoring


# --------------------------------------------------------------------------
# Submitted values
# --------------------------------------------------------------------------


def validate_field_value(field: FormField, value: Any) -> None:
    """Validate one non-blank submitted value against its field's type."""
    field_type = field.field_type
    label = field.label
    if field_type in (FieldType.SHORT_TEXT, FieldType.LONG_TEXT):
        if not isinstance(value, str):
            raise DomainError(f"Expected text for: {label}")
        return
    if field_type == FieldType.NUMBER:
        if not is_number(value):
            raise DomainError(f"Expected a number for: {label}")
        return
    if field_type == FieldType.CHECKBOX:
        if not isinstance(value, bool):
            raise DomainError(f"Expected a boolean for: {label}")
        return
    if field_type == FieldType.SINGLE_SELECT:
        if not isinstance(value, str):
            raise DomainError(f"Expected one of the configured options for: {label}")
        if field.options and value not in field.options:
            raise DomainError(f"Invalid option for: {label}")
        return
    if field_type == FieldType.MULTIPLE_SELECT:
        if not isinstance(value, list):
            raise DomainError(f"Expected a list for: {label}")
        if any(not isinstance(item, str) for item in value):
            raise DomainError(f"Expected a list of options for: {label}")
        if len(set(value)) != len(value):
            raise DomainError(f"The same option was selected twice for: {label}")
        if field.options and any(item not in field.options for item in value):
            raise DomainError(f"Invalid option for: {label}")
        return
    if field_type == FieldType.RATING:
        if not is_number(value):
            raise DomainError(f"Expected a rating for: {label}")
        bounds = rating_bounds(field)
        if bounds is not None and not bounds[0] <= float(value) <= bounds[1]:
            raise DomainError(
                f"Rating must be between {bounds[0]:g} and {bounds[1]:g} for: {label}"
            )
        return
    if field_type == FieldType.DATE:
        if not isinstance(value, str) or not _ISO_DATE.match(value.strip()):
            raise DomainError(f"Expected an ISO date (YYYY-MM-DD) for: {label}")
        try:
            date.fromisoformat(value.strip())
        except ValueError as exc:
            raise DomainError(f"Not a real calendar date for: {label}") from exc
        return
    if field_type == FieldType.URL:
        if not isinstance(value, str):
            raise DomainError(f"Expected a URL for: {label}")
        parsed = urlsplit(value.strip())
        if parsed.scheme not in ("http", "https") or not parsed.netloc:
            raise DomainError(f"Expected an http(s) URL for: {label}")
        return


def validate_answers(
    fields: Iterable[FormField], answers: Mapping[str, Any]
) -> None:
    """Validate a complete submitted answer set against a form's fields.

    The authoritative rule set for both extraction and quality submissions.
    """
    known = {field.stable_key: field for field in fields}
    unknown = set(answers) - set(known)
    if unknown:
        raise DomainError(f"Unknown form fields: {', '.join(sorted(unknown))}")
    for key, field in known.items():
        value = answers.get(key)
        if is_blank(value):
            if field.required:
                raise DomainError(f"Required field is missing: {field.label}")
            continue
        validate_field_value(field, value)
