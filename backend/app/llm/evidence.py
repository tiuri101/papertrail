from __future__ import annotations

import re
import unicodedata
from typing import Any

from app.llm.models import EvidenceStatus


def normalize_quote(value: str) -> str:
    value = unicodedata.normalize("NFKC", value)
    value = value.replace("\u00ad", "")
    return re.sub(r"\s+", " ", value).strip().casefold()


def verify_evidence(
    evidence: list[dict[str, Any]],
    pages: dict[int, str],
    *,
    required: bool,
    max_items: int,
    max_quote_chars: int,
) -> tuple[list[dict[str, Any]], EvidenceStatus]:
    checked: list[dict[str, Any]] = []
    for item in evidence[:max_items]:
        page = int(item["page"])
        quote = str(item["quote"])[:max_quote_chars]
        verified = bool(quote.strip()) and normalize_quote(quote) in normalize_quote(
            pages.get(page, "")
        )
        section = item.get("section")
        checked.append(
            {
                "page": page,
                "quote": quote,
                "section": str(section)[:300] if section else None,
                "verified": verified,
            }
        )
    if not checked:
        return (
            checked,
            EvidenceStatus.UNVERIFIED if required else EvidenceStatus.NOT_REQUIRED,
        )
    verified_count = sum(bool(item["verified"]) for item in checked)
    if verified_count == len(checked):
        return checked, EvidenceStatus.VERIFIED
    if verified_count:
        return checked, EvidenceStatus.PARTIAL
    return checked, EvidenceStatus.UNVERIFIED
