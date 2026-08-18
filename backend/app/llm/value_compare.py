"""Canonical-JSON hashing and type-tolerant value equality shared by
suggestion-provenance recording (``llm/service.py``) and the canonical
evidence dataset (``reporting/evidence_dataset.py``). Kept dependency-free
of both so neither has to import the other.
"""

from __future__ import annotations

import json
from typing import Any


def canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def values_equal(left: Any, right: Any) -> bool:
    if isinstance(left, list) and isinstance(right, list):
        return sorted(map(canonical_json, left)) == sorted(map(canonical_json, right))
    if isinstance(left, (int, float)) and isinstance(right, (int, float)):
        return float(left) == float(right)
    return bool(left == right)
