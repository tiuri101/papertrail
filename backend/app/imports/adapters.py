from __future__ import annotations

import csv
import io
import re
from collections.abc import Callable
from pathlib import Path
from typing import Any

from openpyxl import load_workbook


def decode_text(data: bytes) -> str:
    for encoding in ("utf-8-sig", "utf-8", "cp1252", "latin-1"):
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", errors="replace")


def parse_csv(data: bytes) -> list[dict[str, Any]]:
    text = decode_text(data)
    sample = text[:4096]
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters=",;\t|")
        dialect.doublequote = True
    except csv.Error:
        dialect = csv.excel
    return [dict(row) for row in csv.DictReader(io.StringIO(text), dialect=dialect)]


def parse_xlsx(data: bytes) -> list[dict[str, Any]]:
    workbook = load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    sheet = workbook.active
    rows = sheet.iter_rows(values_only=True)
    headers = [str(value).strip() if value is not None else "" for value in next(rows, ())]
    return [
        {headers[index]: value for index, value in enumerate(row) if index < len(headers) and headers[index]}
        for row in rows
        if any(value is not None and str(value).strip() for value in row)
    ]


def parse_ris(data: bytes) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    current: dict[str, Any] = {}
    authors: list[str] = []
    mapping = {"TI": "title", "T1": "title", "AB": "abstract", "DO": "doi", "PY": "year", "Y1": "year", "JO": "venue", "JF": "venue", "UR": "url", "KW": "keywords"}
    for raw_line in decode_text(data).splitlines():
        match = re.match(r"^([A-Z0-9]{2})  - ?(.*)$", raw_line)
        if not match:
            continue
        tag, value = match.groups()
        if tag == "TY":
            current = {"publication_type": value}
            authors = []
        elif tag in {"AU", "A1"}:
            authors.append(value)
        elif tag == "ER":
            if authors:
                current["authors"] = "; ".join(authors)
            if current:
                records.append(current)
            current = {}
            authors = []
        elif tag == "KW":
            current.setdefault("keywords", []).append(value)
        elif tag in mapping:
            current[mapping[tag]] = value
    if current:
        if authors:
            current["authors"] = "; ".join(authors)
        records.append(current)
    for record in records:
        if isinstance(record.get("keywords"), list):
            record["keywords"] = "; ".join(record["keywords"])
    return records


def _split_bibtex_entries(text: str) -> list[tuple[str, str, str]]:
    entries: list[tuple[str, str, str]] = []
    index = 0
    while True:
        marker = text.find("@", index)
        if marker < 0:
            break
        header = re.match(r"@(\w+)\s*\{\s*([^,]+),", text[marker:], re.I)
        if not header:
            index = marker + 1
            continue
        entry_type, key = header.group(1), header.group(2).strip()
        body_start = marker + header.end()
        depth = 1
        pos = body_start
        while pos < len(text) and depth:
            if text[pos] == "{":
                depth += 1
            elif text[pos] == "}":
                depth -= 1
            pos += 1
        entries.append((entry_type, key, text[body_start:pos - 1]))
        index = pos
    return entries


def parse_bibtex(data: bytes) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for entry_type, key, body in _split_bibtex_entries(decode_text(data)):
        record: dict[str, Any] = {"publication_type": entry_type.lower(), "source_key": key}
        field_pattern = re.compile(r"(\w+)\s*=\s*(?:\{((?:[^{}]|\{[^{}]*\})*)\}|\"([^\"]*)\"|([^,]+))\s*,?", re.S)
        for match in field_pattern.finditer(body):
            name = match.group(1).lower()
            value = next(group for group in match.groups()[1:] if group is not None).strip()
            mapped = {"author": "authors", "journal": "venue", "booktitle": "venue", "url": "url"}.get(name, name)
            record[mapped] = re.sub(r"\s+", " ", value)
        records.append(record)
    return records


ALIASES: dict[str, tuple[str, ...]] = {
    "title": ("title", "document title", "article title", "item title"),
    "authors": ("authors", "author", "author full names"),
    "abstract": ("abstract", "abstract note"),
    "doi": ("doi", "digital object identifier"),
    "year": ("year", "publication year", "cover date"),
    "venue": ("venue", "publication title", "source title", "journal", "conference"),
    "publication_type": ("publication type", "document type", "type"),
    "url": ("url", "link", "pdf link"),
    "keywords": ("keywords", "author keywords", "index keywords"),
    "isbn": ("isbn",),
    "issn": ("issn",),
}


def normalize_imported_row(row: dict[str, Any], explicit_mapping: dict[str, str] | None = None) -> dict[str, Any]:
    normalized_keys = {str(key).strip().lower(): value for key, value in row.items()}
    parsed: dict[str, Any] = {}
    if explicit_mapping:
        for source, target in explicit_mapping.items():
            if source in row and row[source] not in (None, ""):
                parsed[target] = row[source]
    for target, aliases in ALIASES.items():
        if target in parsed:
            continue
        for alias in aliases:
            if alias in normalized_keys and normalized_keys[alias] not in (None, ""):
                parsed[target] = normalized_keys[alias]
                break
    return parsed


def parse_file(filename: str, data: bytes) -> list[dict[str, Any]]:
    suffix = Path(filename).suffix.lower()
    parsers: dict[str, Callable[[bytes], list[dict[str, Any]]]] = {
        ".csv": parse_csv,
        ".tsv": parse_csv,
        ".xlsx": parse_xlsx,
        ".ris": parse_ris,
        ".bib": parse_bibtex,
        ".bibtex": parse_bibtex,
    }
    if suffix not in parsers:
        raise ValueError(f"Unsupported import format: {suffix or 'unknown'}")
    return parsers[suffix](data)
