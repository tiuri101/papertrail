"""Deterministic source-ID assignment for RQ synthesis: every citable fact
the LLM may reference gets a stable ``SRC-xxxx`` id up front, in stable input
order, so prompts and validation never depend on model-invented identifiers.
"""

from __future__ import annotations

from dataclasses import dataclass

from app.reporting.evidence_dataset import EvidenceDataset, EvidenceFact


@dataclass(frozen=True)
class SourceEntry:
    id: str
    fact: EvidenceFact
    publication_title: str


def assign_source_ids(dataset: EvidenceDataset) -> list[SourceEntry]:
    """One entry per answered fact, in stable publication/field order.

    Unanswered (``missing``/``pending_reconciliation``) facts carry no value
    to cite and are excluded -- the LLM can only ever cite something that was
    actually answered.
    """
    entries: list[SourceEntry] = []
    counter = 1
    for publication in dataset.publications:
        for fact in dataset.facts_for(publication.id).values():
            if fact.state != "answered":
                continue
            entries.append(SourceEntry(f"SRC-{counter:04d}", fact, publication.title))
            counter += 1
    return entries


def render_source_line(entry: SourceEntry) -> str:
    return (
        f"[{entry.id}] Publication: {entry.publication_title} | "
        f"Field: {entry.fact.label} | Value: {entry.fact.value}"
    )


def validate_source_ids(claimed: list[str], known: set[str]) -> list[str]:
    """The valid subset of ``claimed`` -- unknown/invented ids are silently
    discarded, never raised on, since a hallucinated citation is expected
    model behavior to defend against, not a caller bug."""
    return [source_id for source_id in claimed if source_id in known]
