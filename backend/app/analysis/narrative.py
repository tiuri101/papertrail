from __future__ import annotations

import re
from typing import Any

from app.llm.ollama import (
    OllamaClientProtocol,
    OllamaResponseError,
    create_ollama_client,
)

NARRATIVE_SCHEMA = {
    "type": "object",
    "properties": {"summary": {"type": "string"}},
    "required": ["summary"],
}

_BASE_INSTRUCTIONS = (
    "Given aggregated statistics from a systematic-review team's workspace, write "
    "a short, plain-language summary (3-6 sentences) for a reviewer. Call out "
    "notable gaps, skewed distributions, or attrition patterns. Do not invent "
    "numbers that are not given to you."
)

_STAGE_SYSTEM_PROMPTS = {
    "duplicate_review": (
        "You are assisting a systematic-review team in interpreting their "
        "deduplication results. " + _BASE_INSTRUCTIONS
    ),
    "title_abstract_screening": (
        "You are assisting a systematic-review team in interpreting their "
        "title/abstract screening results, including which criteria most often "
        "drove exclusions. " + _BASE_INSTRUCTIONS
    ),
    "full_text_screening": (
        "You are assisting a systematic-review team in interpreting their "
        "full-text eligibility assessment results, including retrieval problems "
        "and which criteria most often drove exclusions. " + _BASE_INSTRUCTIONS
    ),
    "extraction_quality": (
        "You are assisting a systematic-review team in interpreting the results "
        "of their data-extraction and quality-assessment phase. " + _BASE_INSTRUCTIONS
    ),
}

_CAMEL_CASE_BOUNDARY = re.compile(r"(?<!^)(?=[A-Z])")


def _humanize(key: str) -> str:
    return _CAMEL_CASE_BOUNDARY.sub(" ", key).lower()


def _format_breakdown(items: list[dict[str, Any]]) -> str:
    parts = [
        f"{item.get('label') or item.get('option')}={item['count']}" for item in items
    ]
    return ", ".join(parts) if parts else "none"


def _format_numeric_stats(stats: dict[str, Any]) -> str:
    return "min={min}, max={max}, mean={mean}, median={median}".format(**stats)


def _describe_generic_stats(stats: dict[str, Any]) -> str:
    lines: list[str] = []
    for key, value in stats.items():
        if value in (None, [], {}):
            continue
        if (
            isinstance(value, list)
            and value
            and isinstance(value[0], dict)
            and "count" in value[0]
        ):
            lines.append(f"- {_humanize(key)}: {_format_breakdown(value)}")
        elif (
            isinstance(value, dict) and {"min", "max", "mean", "median"} <= value.keys()
        ):
            lines.append(f"- {_humanize(key)}: {_format_numeric_stats(value)}")
        else:
            lines.append(f"- {_humanize(key)}: {value}")
    return "\n".join(lines) or "No data has been recorded for this stage yet."


def _describe_extraction_field(field: dict[str, Any]) -> str:
    total = field["totalCount"]
    answered = field["answeredCount"]
    percent = round(100 * answered / total) if total else 0
    lines = [
        f"- {field['label']} ({field['source']}, {field['fieldType']}): "
        f"{answered}/{total} answered ({percent}%)"
    ]
    option_counts = field.get("optionCounts")
    if option_counts:
        top = ", ".join(
            f"{item['option']}={item['count']}" for item in option_counts[:5]
        )
        lines.append(f"  top values: {top}")
    numeric_stats = field.get("numericStats")
    if numeric_stats:
        lines.append(f"  {_format_numeric_stats(numeric_stats)}")
    return "\n".join(lines)


def _describe_extraction_stats(stats: dict[str, Any]) -> str:
    lines = [_describe_extraction_field(field) for field in stats["fields"]]
    quality_total_score = stats.get("qualityTotalScore")
    if quality_total_score:
        lines.append(
            f"- Overall quality score: {_format_numeric_stats(quality_total_score)}"
        )
    body = "\n".join(lines) or "No extraction or quality data has been recorded yet."
    return f"Project has {stats['totalPublications']} included publications.\n\n{body}"


def build_prompt(stage: str, stats: dict[str, Any]) -> list[dict[str, str]]:
    system = _STAGE_SYSTEM_PROMPTS.get(stage)
    if system is None:
        raise ValueError(f"Unknown analysis stage: {stage}")
    body = (
        _describe_extraction_stats(stats)
        if stage == "extraction_quality"
        else _describe_generic_stats(stats)
    )
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": body},
    ]


def generate_narrative(
    stage: str,
    stats: dict[str, Any],
    client: OllamaClientProtocol | None = None,
    *,
    attempt: int = 1,
) -> str:
    client = client or create_ollama_client(attempt=attempt)
    response = client.chat(
        messages=build_prompt(stage, stats), output_schema=NARRATIVE_SCHEMA
    )
    summary = response.content.get("summary")
    if not isinstance(summary, str) or not summary.strip():
        raise OllamaResponseError("Ollama did not return a narrative summary")
    return summary.strip()
