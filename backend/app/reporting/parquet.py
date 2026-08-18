from __future__ import annotations

import csv
import json
from datetime import datetime
from enum import Enum
from io import BytesIO, StringIO
from typing import Any

import pyarrow as pa  # type: ignore[import-untyped]
import pyarrow.parquet as pq  # type: ignore[import-untyped]
from sqlalchemy.orm import Session

from app.reporting.results import build_final_results

_BASE_COLUMNS: tuple[tuple[str, pa.DataType], ...] = (
    ("publication_id", pa.string()),
    ("title", pa.string()),
    ("authors", pa.string()),
    ("publication_year", pa.int64()),
    ("venue", pa.string()),
    ("publication_type", pa.string()),
    ("doi", pa.string()),
    ("publisher_url", pa.string()),
    ("keywords", pa.string()),
    ("extraction_status", pa.string()),
    ("extraction_resolution_method", pa.string()),
    ("extraction_completed_at", pa.string()),
    ("extraction_reviewer_name", pa.string()),
    ("quality_status", pa.string()),
    ("quality_completed_at", pa.string()),
    ("quality_reviewer_name", pa.string()),
    ("quality_total_score", pa.float64()),
)
_BASE_COLUMN_NAMES = {column[0] for column in _BASE_COLUMNS}


def _scalar(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, Enum):
        return str(value.value)
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, (dict, list, tuple)):
        return json.dumps(value, ensure_ascii=False, default=str)
    return value


def _answer_columns(prefix: str, answers: dict[str, Any]) -> dict[str, str]:
    return {f"{prefix}_{key}": json.dumps(value, ensure_ascii=False, default=str)
            for key, value in answers.items()}


def build_analysis_rows(db: Session, project_id: str) -> list[dict[str, Any]]:
    """Flatten final included results for interoperable tabular exports."""
    results = build_final_results(db, project_id)
    rows: list[dict[str, Any]] = []

    for item in results["items"]:
        publication = item["publication"]
        extraction = item.get("extraction") or {}
        quality = item.get("quality") or {}
        row: dict[str, Any] = {
            "publication_id": publication.get("id"),
            "title": publication.get("title"),
            "authors": publication.get("authors"),
            "publication_year": publication.get("publicationYear"),
            "venue": publication.get("venue"),
            "publication_type": publication.get("publicationType"),
            "doi": publication.get("doi"),
            "publisher_url": publication.get("publisherUrl"),
            "keywords": publication.get("keywords"),
            "extraction_status": _scalar(extraction.get("status")),
            "extraction_resolution_method": extraction.get("resolutionMethod"),
            "extraction_completed_at": _scalar(extraction.get("completedAt")),
            "extraction_reviewer_name": extraction.get("reviewerName"),
            "quality_status": _scalar(quality.get("status")),
            "quality_completed_at": _scalar(quality.get("completedAt")),
            "quality_reviewer_name": quality.get("reviewerName"),
            "quality_total_score": quality.get("totalScore"),
        }
        row.update(_answer_columns("extraction", extraction.get("answers") or {}))
        row.update(_answer_columns("quality", quality.get("answers") or {}))
        rows.append(row)
    return rows


def _analysis_columns(rows: list[dict[str, Any]]) -> list[str]:
    dynamic_columns = {
        key
        for row in rows
        for key in row
        if key.startswith(("extraction_", "quality_")) and key not in _BASE_COLUMN_NAMES
    }
    return [*(column[0] for column in _BASE_COLUMNS), *sorted(dynamic_columns)]


def build_parquet(db: Session, project_id: str) -> bytes:
    """Build a typed Parquet dataset from final included results."""
    rows = build_analysis_rows(db, project_id)
    columns = _analysis_columns(rows)
    types = dict(_BASE_COLUMNS)
    schema = pa.schema([
        pa.field(name, types.get(name, pa.string()))
        for name in columns
    ])
    normalized_rows = [
        {name: _scalar(row.get(name)) for name in columns}
        for row in rows
    ]
    table = pa.Table.from_pylist(normalized_rows, schema=schema)
    buffer = BytesIO()
    pq.write_table(table, buffer, compression="snappy")
    return buffer.getvalue()


def build_csv(db: Session, project_id: str) -> bytes:
    """Build a flat CSV dataset from final included results."""
    rows = build_analysis_rows(db, project_id)
    columns = _analysis_columns(rows)

    def csv_value(value: Any) -> Any:
        normalized = _scalar(value)
        if isinstance(normalized, str) and normalized.startswith(("=", "+", "-", "@")):
            return "'" + normalized
        return normalized

    output = StringIO(newline="")
    writer = csv.DictWriter(output, fieldnames=columns, extrasaction="ignore")
    writer.writeheader()
    writer.writerows(
        {name: csv_value(row.get(name)) for name in columns}
        for row in rows
    )
    return output.getvalue().encode("utf-8-sig")


def _json_default(value: Any) -> str:
    if isinstance(value, Enum):
        return str(value.value)
    if isinstance(value, datetime):
        return value.isoformat()
    return str(value)


def build_json(db: Session, project_id: str) -> bytes:
    """Build a structured JSON export from final included results."""
    return json.dumps(
        build_final_results(db, project_id),
        ensure_ascii=False,
        default=_json_default,
        indent=2,
    ).encode("utf-8")
