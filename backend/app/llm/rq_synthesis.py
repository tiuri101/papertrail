"""Orchestrates one RQ-synthesis attempt: build the canonical evidence
dataset, assign deterministic source IDs, run a per-chunk candidate-findings
pass, consolidate when there was more than one chunk, then re-validate every
statement's source IDs against the master known-ID set before returning --
defense in depth against a consolidation-pass hallucination, per
docs/llm-assisted-extraction.md's "never trust LLM output blind" pattern.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy.orm import Session

from app.llm.installation_settings import effective_llm_settings
from app.llm.ollama import OllamaClientProtocol, create_ollama_client
from app.llm.rq_chunking import chunk_facts
from app.llm.rq_prompt import (
    candidate_messages,
    consolidation_messages,
    statements_output_schema,
)
from app.llm.rq_sources import SourceEntry, assign_source_ids, validate_source_ids
from app.llm.rq_validation import RqSynthesisResult, validate_rq_synthesis_result
from app.llm.structured import add_metrics, validated_chat
from app.reporting.evidence_dataset import build_evidence_dataset

_EMPTY_LIMITATION = "No extraction or quality-assessment data is available yet."


def _source_ref(entry: SourceEntry) -> dict[str, Any]:
    fact = entry.fact
    return {
        "publicationId": fact.publication_id,
        "publicationTitle": entry.publication_title,
        "sourceType": fact.source_type,
        "fieldKey": fact.field_key,
        "label": fact.label,
        "value": fact.value,
        "evidence": [
            {
                "page": item.page,
                "quote": item.quote,
                "section": item.section,
                "verified": item.verified,
            }
            for item in fact.evidence
        ],
    }


def _filtered_candidate(
    result: RqSynthesisResult, known_ids: set[str]
) -> dict[str, Any]:
    statements = []
    for statement in result.statements:
        valid_ids = validate_source_ids(statement.source_ids, known_ids)
        if not valid_ids:
            continue
        statements.append({"claim": statement.claim, "sourceIds": valid_ids})
    return {"statements": statements, "limitations": list(result.limitations)}


def run_rq_synthesis(
    db: Session,
    project_id: str,
    research_question_text: str,
    *,
    client: OllamaClientProtocol | None = None,
    attempt: int = 1,
) -> tuple[dict[str, Any], dict[str, int]]:
    dataset = build_evidence_dataset(db, project_id)
    entries = assign_source_ids(dataset)
    metrics: dict[str, int] = {}
    if not entries:
        return {
            "statements": [],
            "limitations": [_EMPTY_LIMITATION],
            "sourceRefs": {},
        }, metrics

    entries_by_id = {entry.id: entry for entry in entries}
    schema = statements_output_schema()
    client = client or create_ollama_client(attempt=attempt)
    context_length = effective_llm_settings(db).llm_context_length
    chunks = chunk_facts(entries, context_length)

    candidates: list[dict[str, Any]] = []
    for chunk in chunks:
        result, response = validated_chat(
            client,
            candidate_messages(research_question_text, chunk),
            schema,
            validate_rq_synthesis_result,
        )
        add_metrics(metrics, response)
        chunk_known = {entry.id for entry in chunk}
        candidates.append(_filtered_candidate(result, chunk_known))

    if len(candidates) > 1:
        consolidated, response = validated_chat(
            client,
            consolidation_messages(research_question_text, candidates),
            schema,
            validate_rq_synthesis_result,
        )
        add_metrics(metrics, response)
        final_payload = _filtered_candidate(consolidated, set(entries_by_id))
    else:
        final_payload = candidates[0]

    # Final validation pass: re-check against the *global* known-id set even
    # though candidates were already chunk-local-validated, since the
    # consolidation pass itself could in principle hallucinate a citation.
    known_ids = set(entries_by_id)
    kept_statements: list[dict[str, Any]] = []
    cited_ids: set[str] = set()
    for statement in final_payload["statements"]:
        valid_ids = validate_source_ids(statement["sourceIds"], known_ids)
        if not valid_ids:
            continue
        kept_statements.append({"claim": statement["claim"], "sourceIds": valid_ids})
        cited_ids.update(valid_ids)

    source_refs = {
        source_id: _source_ref(entries_by_id[source_id]) for source_id in cited_ids
    }
    result_payload = {
        "statements": kept_statements,
        "limitations": list(final_payload["limitations"]),
        "sourceRefs": source_refs,
    }
    return result_payload, metrics
