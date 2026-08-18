"""Deterministic greedy bin-packing of RQ source facts into token-budgeted
chunks, mirroring ``app.llm.prompt.chunk_pages``'s char-budget approach.
Every entry appears in exactly one chunk; none are ever dropped.
"""

from __future__ import annotations

from app.llm.rq_sources import SourceEntry, render_source_line


def chunk_facts(
    entries: list[SourceEntry], budget_tokens: int
) -> list[list[SourceEntry]]:
    char_budget = max(2000, budget_tokens * 3)
    chunks: list[list[SourceEntry]] = []
    current: list[SourceEntry] = []
    current_chars = 0
    for entry in entries:
        line_chars = len(render_source_line(entry))
        if current and current_chars + line_chars > char_budget:
            chunks.append(current)
            current, current_chars = [], 0
        current.append(entry)
        current_chars += line_chars
    if current:
        chunks.append(current)
    return chunks or [[]]
