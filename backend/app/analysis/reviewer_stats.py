"""Pure, deterministic inter-rater agreement mathematics for the anonymized
reviewer-analysis feature. No DB access and no LLM involvement -- every
function here takes already-fetched category labels and returns numbers, so
it's fully unit-testable with small hand-calculable fixtures.
"""

from __future__ import annotations

import hashlib
from collections import Counter
from dataclasses import dataclass, field


@dataclass(frozen=True)
class ConfusionMatrix:
    categories: list[str]
    # counts[a][b] = number of publications where reviewer A chose `a` and
    # reviewer B chose `b`
    counts: dict[str, dict[str, int]]

    def to_rows(self) -> list[dict[str, object]]:
        return [
            {
                "actual": row_category,
                "counts": {
                    col_category: self.counts[row_category][col_category]
                    for col_category in self.categories
                },
            }
            for row_category in self.categories
        ]


@dataclass(frozen=True)
class FleissResult:
    kappa: float | None
    reason: str | None = None


def raw_agreement_rate(pairs: list[tuple[str, str]]) -> float | None:
    if not pairs:
        return None
    agreeing = sum(1 for a, b in pairs if a == b)
    return agreeing / len(pairs)


def confusion_matrix(pairs: list[tuple[str, str]], categories: list[str]) -> ConfusionMatrix:
    """Only includes categories actually present in `categories` -- callers
    should pass the set of outcomes actually used by the stage (e.g.
    include/exclude/uncertain/duplicate), not a fixed universal list."""
    counts: dict[str, dict[str, int]] = {
        row: dict.fromkeys(categories, 0) for row in categories
    }
    for a, b in pairs:
        if a in counts and b in counts[a]:
            counts[a][b] += 1
    return ConfusionMatrix(categories=list(categories), counts=counts)


def cohens_kappa(pairs: list[tuple[str, str]], categories: list[str]) -> float | None:
    """Returns None (never 0) when mathematically undefined: no comparable
    data, or expected agreement is exactly 1 (every rater always chose the
    same single category, making chance-corrected agreement meaningless)."""
    n = len(pairs)
    if n == 0:
        return None
    po = sum(1 for a, b in pairs if a == b) / n
    counts_a: Counter[str] = Counter(a for a, _ in pairs)
    counts_b: Counter[str] = Counter(b for _, b in pairs)
    pe = sum((counts_a.get(c, 0) / n) * (counts_b.get(c, 0) / n) for c in categories)
    if pe >= 1:
        return None
    return (po - pe) / (1 - pe)


def fleiss_kappa(rows: list[dict[str, int]], categories: list[str]) -> FleissResult:
    """`rows`: one dict per publication mapping category -> number of
    (original, non-additional) raters who chose it for that publication.
    Every row must sum to the same rater count `n` (only publications with a
    complete comparable reviewer set should be passed in) and there must be
    more than two raters -- Cohen's kappa is the right statistic for exactly
    two, this function is for genuinely multi-rater comparisons."""
    if not rows:
        return FleissResult(kappa=None, reason="No comparable publications")
    rater_counts = {sum(row.values()) for row in rows}
    if len(rater_counts) != 1:
        return FleissResult(
            kappa=None,
            reason="Publications do not all have the same number of raters",
        )
    n = next(iter(rater_counts))
    if n < 3:
        return FleissResult(
            kappa=None, reason="Fleiss' kappa requires more than two raters"
        )
    item_count = len(rows)
    p_i_values = []
    category_totals: Counter[str] = Counter()
    for row in rows:
        sum_sq = sum(row.get(c, 0) ** 2 for c in categories)
        p_i_values.append((sum_sq - n) / (n * (n - 1)))
        for c in categories:
            category_totals[c] += row.get(c, 0)
    p_bar = sum(p_i_values) / item_count
    p_e = sum((category_totals[c] / (item_count * n)) ** 2 for c in categories)
    if p_e >= 1:
        return FleissResult(
            kappa=None, reason="Expected agreement is 1; kappa is undefined"
        )
    return FleissResult(kappa=(p_bar - p_e) / (1 - p_e))


@dataclass
class PseudonymAssignment:
    label_by_id: dict[str, str] = field(default_factory=dict)

    def label(self, membership_id: str) -> str:
        return self.label_by_id[membership_id]


def pseudonymize(
    secret: str, project_id: str, membership_ids: list[str]
) -> PseudonymAssignment:
    """Deterministic, project-scoped, unguessable "Reviewer A/B/C..."
    labels. Stable across repeated calls for the same project + reviewer set
    without persisting a mapping table: sort by a salted hash of the
    membership id, then assign letters in that order."""

    def hashed(membership_id: str) -> str:
        return hashlib.sha256(
            f"{secret}:{project_id}:{membership_id}".encode()
        ).hexdigest()

    ordered = sorted(set(membership_ids), key=hashed)
    labels: dict[str, str] = {}
    for index, membership_id in enumerate(ordered):
        labels[membership_id] = _letter_label(index)
    return PseudonymAssignment(label_by_id=labels)


def _letter_label(index: int) -> str:
    """0 -> "Reviewer A", 25 -> "Reviewer Z", 26 -> "Reviewer AA", ..."""
    letters = ""
    n = index
    while True:
        n, remainder = divmod(n, 26)
        letters = chr(ord("A") + remainder) + letters
        if n == 0:
            break
        n -= 1
    return f"Reviewer {letters}"
