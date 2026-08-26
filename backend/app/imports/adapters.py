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
    assert sheet is not None
    rows = sheet.iter_rows(values_only=True)
    headers = [
        str(value).strip() if value is not None else "" for value in next(rows, ())
    ]
    return [
        {
            headers[index]: value
            for index, value in enumerate(row)
            if index < len(headers) and headers[index]
        }
        for row in rows
        if any(value is not None and str(value).strip() for value in row)
    ]


# --------------------------------------------------------------------------
# RIS
#
# Reference-manager exports agree on the shape of a RIS line -- a short tag,
# a hyphen, a value -- and on almost nothing else. Scopus writes the abstract
# under AB and EndNote under N2; Web of Science puts the journal in SO,
# Scopus in T2, PubMed-derived files in JT/JF; the DOI is DO nearly
# everywhere and DI in Web of Science. Long fields wrap onto continuation
# lines that carry no tag at all, so a parser that only looks at tagged lines
# silently truncates every abstract it reads.
#
# So: recognise the union of the tags those exporters actually emit, keep
# continuation lines attached to the tag they continue, and resolve
# competing tags for one field by preference rather than by whichever
# happened to come last.
# --------------------------------------------------------------------------

#: Tags Papertrail understands, plus the ones it deliberately ignores. Used
#: only to decide whether a *non-canonical* line ("PMID- 1234", "AU - Doe")
#: starts a new field: a canonical "XX  - value" line is always a tag, so an
#: exporter using a tag nobody has heard of still parses.
_RIS_KNOWN_TAGS = frozenset(
    [
        "TY", "ER", "ID", "TI", "T1", "T2", "T3", "CT", "BT", "ST", "AU", "A1",
        "A2", "A3", "A4", "AB", "N1", "N2", "KW", "PY", "Y1", "Y2", "DA", "JO",
        "JF", "JA", "J1", "J2", "JT", "SO", "DO", "DI", "DP", "UR", "L1", "L2",
        "L3", "L4", "LK", "LID", "SN", "BN", "IS", "VL", "SP", "EP", "BP", "PB",
        "CY", "AD", "AN", "C1", "C2", "C3", "C7", "CN", "DB", "LA", "M1", "M2",
        "M3", "PMID", "PMCID", "RP", "SE", "TA", "UK",
    ]
)

#: Canonical RIS is ``XX  - value``. MEDLINE-flavoured files (and a few
#: exporters) use one space, no space, or a four-character tag, so accept a
#: looser shape too -- but only for a tag in _RIS_KNOWN_TAGS, so a wrapped
#: abstract line such as "AI - based triage was compared" is not mistaken
#: for the start of a new field.
_RIS_LINE = re.compile(r"^([A-Z][A-Z0-9]{1,3})(\s{0,3})-[ \t]?(.*)$")

#: Every tag that can supply one normalized field, best source first. The
#: first tag present in a record wins, so a Scopus record carrying both T2
#: and JO is not decided by line order.
_RIS_FIELD_TAGS: dict[str, tuple[str, ...]] = {
    "title": ("TI", "T1", "CT", "ST"),
    "abstract": ("AB", "N2"),
    "doi": ("DO", "DI", "LID"),
    "year": ("PY", "Y1", "DA", "Y2"),
    "venue": ("JF", "JO", "JT", "T2", "SO", "JA", "J1", "J2", "BT", "T3"),
    "url": ("UR", "LK", "L2"),
    "publisher": ("PB",),
    "pubmed_id": ("PMID",),
}

_RIS_AUTHOR_TAGS = ("AU", "A1")
#: SN carries an ISSN for serials and an ISBN for books -- the tag does not
#: say which, so the value has to.
_ISSN_SHAPE = re.compile(r"^\d{4}-?\d{3}[\dxX]$")


def _ris_line(raw_line: str) -> tuple[str, str] | None:
    """The (tag, value) a RIS line starts, or None for a continuation line."""
    match = _RIS_LINE.match(raw_line)
    if not match:
        return None
    tag, spacing, value = match.groups()
    canonical = len(tag) == 2 and spacing == "  "
    if canonical or tag in _RIS_KNOWN_TAGS:
        return tag, value
    return None


def _ris_record(
    tagged: dict[str, list[str]], authors: list[str]
) -> dict[str, Any]:
    record: dict[str, Any] = {}
    if tagged.get("TY"):
        record["publication_type"] = tagged["TY"][0]
    for field, tags in _RIS_FIELD_TAGS.items():
        for tag in tags:
            values = [value for value in tagged.get(tag, ()) if value]
            if values:
                record[field] = values[0]
                break
    if authors:
        record["authors"] = "; ".join(authors)
    if tagged.get("KW"):
        record["keywords"] = "; ".join(value for value in tagged["KW"] if value)
    for value in [*tagged.get("SN", []), *tagged.get("BN", [])]:
        stripped = value.strip()
        if not stripped:
            continue
        field = "issn" if _ISSN_SHAPE.match(stripped) else "isbn"
        record.setdefault(field, stripped)
    if "doi" in record:
        # PubMed's LID carries a trailing type marker: "10.1/x [doi]".
        record["doi"] = re.sub(r"\s*\[[a-z]+\]\s*$", "", record["doi"], flags=re.I)
    return record


def parse_ris(data: bytes) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    tagged: dict[str, list[str]] = {}
    authors: list[str] = []
    open_tag: str | None = None

    def flush() -> None:
        nonlocal tagged, authors, open_tag
        record = _ris_record(tagged, authors)
        if record:
            records.append(record)
        tagged, authors, open_tag = {}, [], None

    for raw_line in decode_text(data).splitlines():
        parsed = _ris_line(raw_line)
        if parsed is None:
            # A continuation of the field above: RIS wraps long values
            # (abstracts, keyword lists) onto untagged lines. Anything before
            # the first tag of a record is exporter preamble and is dropped.
            continuation = raw_line.strip()
            if open_tag and continuation:
                if open_tag in _RIS_AUTHOR_TAGS:
                    authors[-1] = f"{authors[-1]} {continuation}".strip()
                else:
                    values = tagged[open_tag]
                    values[-1] = f"{values[-1]} {continuation}".strip()
            continue
        tag, value = parsed
        if tag == "ER":
            flush()
            continue
        if tag == "TY" and tagged:
            # A record that never closed with ER (a truncated export).
            flush()
        open_tag = tag
        if tag in _RIS_AUTHOR_TAGS:
            authors.append(value)
        tagged.setdefault(tag, []).append(value)
    flush()
    return records


# --------------------------------------------------------------------------
# BibTeX
#
# The supported subset is documented in docs/import-formats.md. In short:
# entries delimited by braces or parentheses, values given as braced groups
# (nested to any depth), quoted strings, bare numbers or @string macros,
# joined with '#'; @string/@comment/@preamble handled; "and"-separated author
# lists normalized to the same "; " separator RIS records use. LaTeX accent
# commands are decoded later, by app.publications.service.clean_text, so they
# survive this stage untouched.
# --------------------------------------------------------------------------

_BIBTEX_ENTRY_HEADER = re.compile(r"@([A-Za-z]+)[ \t\r\n]*([{(])")
#: Braces BibTeX uses purely to protect capitalization ("{COVID-19}",
#: "{{visual analytics}}"). Anything containing a backslash is an accent or
#: other command and is left for clean_text to decode.
_BIBTEX_PROTECTIVE_BRACES = re.compile(r"\{([^{}\\]*)\}")
_BIBTEX_FIELD_NAME = re.compile(r"[A-Za-z][A-Za-z0-9_:\-]*")

_BIBTEX_MONTHS = {
    "jan": "January", "feb": "February", "mar": "March", "apr": "April",
    "may": "May", "jun": "June", "jul": "July", "aug": "August",
    "sep": "September", "oct": "October", "nov": "November", "dec": "December",
}

_BIBTEX_FIELD_MAP = {
    "author": "authors",
    "journal": "venue",
    "journaltitle": "venue",
    "booktitle": "venue",
    "eprint": "arxiv_id",
    "pmid": "pubmed_id",
}


def _bibtex_entry_body(text: str, start: int, close: str) -> tuple[str, int]:
    """The entry body starting just inside its opening delimiter.

    Scans with brace depth and quoted strings so a ')' inside a value cannot
    close a parenthesized entry, and a '}' inside a quoted string cannot
    close a braced one.
    """
    depth = 0
    index = start
    length = len(text)
    while index < length:
        char = text[index]
        if char == "\\":
            index += 2
            continue
        if char == "{":
            depth += 1
        elif char == "}":
            if depth == 0:
                return text[start:index], index + 1
            depth -= 1
        elif depth == 0 and char == close:
            return text[start:index], index + 1
        elif depth == 0 and char == '"':
            index += 1
            while index < length and text[index] != '"':
                index += 2 if text[index] == "\\" else 1
        index += 1
    return text[start:], length


def _split_top_level(body: str, separator: str) -> list[str]:
    """Split on a separator that is not inside braces or a quoted string."""
    parts: list[str] = []
    depth = 0
    in_quotes = False
    current: list[str] = []
    index = 0
    while index < len(body):
        char = body[index]
        if char == "\\":
            current.append(body[index : index + 2])
            index += 2
            continue
        if char == '"' and depth == 0:
            in_quotes = not in_quotes
        elif char == "{":
            depth += 1
        elif char == "}":
            depth = max(0, depth - 1)
        elif char == separator and depth == 0 and not in_quotes:
            parts.append("".join(current))
            current = []
            index += 1
            continue
        current.append(char)
        index += 1
    parts.append("".join(current))
    return parts


def _bibtex_value(raw: str, macros: dict[str, str]) -> str:
    """One field value: braced groups, quoted strings, numbers and macros,
    concatenated with '#'."""
    pieces: list[str] = []
    for piece in _split_top_level(raw, "#"):
        token = piece.strip()
        if not token:
            continue
        braced = token.startswith("{") and token.endswith("}") and len(token) >= 2
        quoted = token.startswith('"') and token.endswith('"') and len(token) >= 2
        if braced or quoted:
            pieces.append(token[1:-1])
        else:
            key = token.lower()
            # An unresolved macro keeps its literal text rather than
            # vanishing: a name is more useful to a reviewer than nothing.
            pieces.append(macros.get(key) or _BIBTEX_MONTHS.get(key) or token)
    return re.sub(r"\s+", " ", "".join(pieces)).strip()


def _strip_protective_braces(value: str) -> str:
    previous = None
    while previous != value and "{" in value:
        previous = value
        value = _BIBTEX_PROTECTIVE_BRACES.sub(r"\1", value)
    return value


def _bibtex_authors(value: str) -> str:
    """BibTeX separates names with " and "; every other Papertrail importer
    separates them with "; ". Split at brace depth zero so a braced corporate
    name containing "and" -- ``author = {{Ministry of Health and Care}}`` --
    stays a single author."""
    names: list[str] = []
    depth = 0
    current: list[str] = []
    index = 0
    while index < len(value):
        char = value[index]
        if char == "\\":
            current.append(value[index : index + 2])
            index += 2
            continue
        if char == "{":
            depth += 1
        elif char == "}":
            depth = max(0, depth - 1)
        elif depth == 0 and value.startswith(" and ", index):
            names.append("".join(current))
            current = []
            index += 5
            continue
        current.append(char)
        index += 1
    names.append("".join(current))
    cleaned = [_strip_protective_braces(name).strip() for name in names]
    return "; ".join(name for name in cleaned if name)


def _bibtex_fields(body: str, macros: dict[str, str]) -> tuple[str, dict[str, str]]:
    parts = _split_top_level(body, ",")
    key = parts[0].strip()
    fields: dict[str, str] = {}
    for part in parts[1:]:
        name, separator, raw = part.partition("=")
        if not separator:
            continue
        name = name.strip().lower()
        if not _BIBTEX_FIELD_NAME.fullmatch(name):
            continue
        fields[name] = _bibtex_value(raw, macros)
    return key, fields


def parse_bibtex(data: bytes) -> list[dict[str, Any]]:
    text = decode_text(data)
    records: list[dict[str, Any]] = []
    macros: dict[str, str] = {}
    index = 0
    while True:
        marker = text.find("@", index)
        if marker < 0:
            break
        header = _BIBTEX_ENTRY_HEADER.match(text, marker)
        if not header:
            index = marker + 1
            continue
        entry_type = header.group(1).lower()
        close = "}" if header.group(2) == "{" else ")"
        body, index = _bibtex_entry_body(text, header.end(), close)
        if entry_type in ("comment", "preamble"):
            continue
        if entry_type == "string":
            for part in _split_top_level(body, ","):
                name, separator, raw = part.partition("=")
                if separator and name.strip():
                    macros[name.strip().lower()] = _bibtex_value(raw, macros)
            continue
        key, fields = _bibtex_fields(body, macros)
        record: dict[str, Any] = {
            "publication_type": entry_type,
            "source_key": key,
        }
        for name, value in fields.items():
            mapped = _BIBTEX_FIELD_MAP.get(name, name)
            if mapped == "arxiv_id" and fields.get("archiveprefix", "").lower() not in (
                "arxiv",
                "",
            ):
                continue
            record[mapped] = (
                _bibtex_authors(value)
                if mapped == "authors"
                else _strip_protective_braces(value)
            )
        records.append(record)
    return records


ALIASES: dict[str, tuple[str, ...]] = {
    "title": ("title", "document title", "article title", "item title"),
    "authors": ("authors", "author", "author full names"),
    "abstract": ("abstract", "abstract note"),
    "doi": ("doi", "digital object identifier"),
    "year": ("year", "publication year", "cover date"),
    "venue": ("venue", "publication title", "source title", "journal", "conference"),
    # "publication_type" is the key the RIS and BibTeX parsers emit for the
    # entry type; without it here their TY/@article was recognised by neither
    # the parser's own key nor a spreadsheet header, and dropped.
    "publication_type": (
        "publication_type",
        "publication type",
        "document type",
        "type",
    ),
    "url": ("url", "link", "pdf link"),
    "keywords": ("keywords", "author keywords", "index keywords"),
    "isbn": ("isbn",),
    "issn": ("issn",),
    # RIS and BibTeX now recover these identifiers on their own, and CSV
    # exports (PubMed, Dimensions, Lens) label them exactly like this.
    "pubmed_id": ("pubmed_id", "pubmed id", "pmid"),
    "arxiv_id": ("arxiv_id", "arxiv id", "arxiv"),
}


def normalize_imported_row(
    row: dict[str, Any], explicit_mapping: dict[str, str] | None = None
) -> dict[str, Any]:
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
