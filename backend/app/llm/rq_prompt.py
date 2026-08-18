from __future__ import annotations

import json
from typing import Any

from app.llm.rq_sources import SourceEntry, render_source_line

RQ_SYNTHESIS_PROMPT_VERSION = "rq_synthesis_v1"

RQ_SYNTHESIS_SYSTEM_PROMPT = (
    "You are analyzing the structured, authoritative results of a systematic or "
    "scoping review -- extracted data and quality-assessment answers across the "
    "review's included publications.\n"
    "Your task is to answer the supplied research question using only the supplied "
    "facts. Base every claim strictly on the facts given to you; never invent "
    "studies, values, counts, or citations that were not supplied.\n"
    "No fact is assumed relevant to the research question in advance -- you decide "
    "which supplied facts actually bear on it, and ignore the rest.\n"
    "Every statement you make must cite the source IDs (e.g. SRC-0001) of the "
    "specific facts it is based on. Cite only source IDs that were supplied to you; "
    "never invent a source ID.\n"
    "Absence of evidence is not evidence of absence -- if the supplied facts don't "
    "cover something, say so rather than asserting a negative conclusion.\n"
    "When supplied facts disagree or point in different directions, describe the "
    "contradiction plainly rather than forcing an artificial consensus.\n"
    "List any limitations of the synthesis (e.g. sparse data, a field mostly "
    "unanswered, small number of contributing studies) explicitly.\n"
    "Respect the exact JSON schema and return no other commentary or hidden "
    "reasoning."
)


def statements_output_schema() -> dict[str, Any]:
    return {
        "type": "object",
        "properties": {
            "statements": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "claim": {"type": "string", "minLength": 1},
                        "sourceIds": {
                            "type": "array",
                            "items": {"type": "string"},
                        },
                    },
                    "required": ["claim", "sourceIds"],
                    "additionalProperties": False,
                },
            },
            "limitations": {
                "type": "array",
                "items": {"type": "string"},
            },
        },
        "required": ["statements", "limitations"],
        "additionalProperties": False,
    }


def _source_lines(entries: list[SourceEntry]) -> str:
    return "\n".join(render_source_line(entry) for entry in entries) or "(no facts)"


def candidate_messages(
    research_question_text: str, entries: list[SourceEntry]
) -> list[dict[str, str]]:
    user = (
        f"RESEARCH QUESTION\n{research_question_text}\n\n"
        f"SUPPLIED FACTS (cite only these source IDs)\n{_source_lines(entries)}"
    )
    return [
        {"role": "system", "content": RQ_SYNTHESIS_SYSTEM_PROMPT},
        {"role": "user", "content": user},
    ]


def consolidation_messages(
    research_question_text: str, candidates: list[dict[str, Any]]
) -> list[dict[str, str]]:
    user = (
        "Consolidate the candidate statement sets below into one final synthesis "
        "answering the research question. Merge overlapping claims, drop "
        "duplicates, and keep every distinct claim's source IDs. Never invent a "
        "new source ID or claim not present in the candidates.\n\n"
        f"RESEARCH QUESTION\n{research_question_text}\n\n"
        f"CANDIDATES\n{json.dumps(candidates, ensure_ascii=False)}"
    )
    return [
        {"role": "system", "content": RQ_SYNTHESIS_SYSTEM_PROMPT},
        {"role": "user", "content": user},
    ]
