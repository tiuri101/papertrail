from __future__ import annotations

import hashlib
import os
import re
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import IO, Any
from unicodedata import normalize
from uuid import uuid4

from fastapi import UploadFile
from pypdf import PdfReader

from app.api.errors import DomainError, PayloadTooLargeError, UnsupportedMediaError
from app.core.config import Settings, get_settings
from app.publications.service import normalize_doi, parse_year

DOI_PATTERN = re.compile(r"10\.\d{4,9}/[-._;()/:A-Z0-9]+", re.IGNORECASE)


@dataclass(frozen=True)
class StoredPdf:
    original_filename: str
    storage_key: str
    file_size: int
    sha256: str
    detected_doi: str | None
    detected_title: str | None
    detected_authors: str | None
    detected_year: int | None


def safe_display_filename(filename: str | None) -> str:
    value = (filename or "document.pdf").replace("\\", "/").split("/")[-1]
    value = "".join(
        char for char in normalize("NFC", value) if char >= " " and char != "\x7f"
    )
    value = value.strip(" .")[:500]
    return value or "document.pdf"


def storage_path(storage_key: str, settings: Settings | None = None) -> Path:
    settings = settings or get_settings()
    key = PurePosixPath(storage_key)
    if key.is_absolute() or ".." in key.parts:
        raise DomainError("Invalid PDF storage key")
    root = settings.pdf_storage_path.resolve()
    candidate = root.joinpath(*key.parts).resolve()
    if candidate != root and root not in candidate.parents:
        raise DomainError("Invalid PDF storage key")
    return candidate


def _metadata(path: Path) -> tuple[str | None, str | None, str | None, int | None]:
    try:
        reader = PdfReader(path, strict=False)
    except Exception as exc:
        raise UnsupportedMediaError("File is not a valid PDF") from exc
    metadata: Any = reader.metadata or {}
    title = str(metadata.get("/Title") or "").strip() or None
    authors = str(metadata.get("/Author") or "").strip() or None
    subject = str(metadata.get("/Subject") or "")
    text = ""
    if not reader.is_encrypted and reader.pages:
        try:
            text = (reader.pages[0].extract_text() or "")[:100_000]
        except Exception:
            text = ""
    candidates = DOI_PATTERN.findall(
        " ".join(part for part in (subject, title or "", text) if part)
    )
    doi = normalize_doi(candidates[0].rstrip('.,;:)"]}')) if candidates else None
    year = parse_year(" ".join(part for part in (subject, text[:10_000]) if part))
    return doi, title, authors, year


def _stage_stream(
    stream: IO[bytes],
    filename: str | None,
    *,
    import_batch_id: str,
    settings: Settings,
) -> StoredPdf:
    safe_name = safe_display_filename(filename)
    limit = settings.max_pdf_size_mb * 1024 * 1024
    key = f"staging/imports/{import_batch_id}/{uuid4()}.pdf"
    path = storage_path(key, settings)
    path.parent.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256()
    size = 0
    first = b""
    tail = b""
    try:
        with path.open("xb") as destination:
            while chunk := stream.read(1024 * 1024):
                size += len(chunk)
                if size > limit:
                    raise PayloadTooLargeError(
                        f"PDF exceeds the {settings.max_pdf_size_mb} MB limit"
                    )
                if len(first) < 1024:
                    first += chunk[: 1024 - len(first)]
                tail = (tail + chunk)[-4096:]
                digest.update(chunk)
                destination.write(chunk)
        if size == 0:
            raise DomainError("PDF is empty")
        if not first.lstrip().startswith(b"%PDF-") or b"%%EOF" not in tail:
            raise UnsupportedMediaError("File is not a valid PDF")
        doi, title, authors, year = _metadata(path)
        return StoredPdf(
            original_filename=safe_name,
            storage_key=key,
            file_size=size,
            sha256=digest.hexdigest(),
            detected_doi=doi,
            detected_title=title,
            detected_authors=authors,
            detected_year=year,
        )
    except Exception:
        path.unlink(missing_ok=True)
        raise


def stage_pdf_stream(
    stream: IO[bytes],
    filename: str | None,
    *,
    import_batch_id: str,
    settings: Settings | None = None,
) -> StoredPdf:
    return _stage_stream(
        stream,
        filename,
        import_batch_id=import_batch_id,
        settings=settings or get_settings(),
    )


async def stage_pdf_upload(
    upload: UploadFile,
    *,
    import_batch_id: str,
    settings: Settings | None = None,
) -> StoredPdf:
    settings = settings or get_settings()
    key = f"staging/imports/{import_batch_id}/{uuid4()}.pdf"
    path = storage_path(key, settings)
    path.parent.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256()
    size = 0
    first = b""
    tail = b""
    limit = settings.max_pdf_size_mb * 1024 * 1024
    try:
        with path.open("xb") as destination:
            while chunk := await upload.read(1024 * 1024):
                size += len(chunk)
                if size > limit:
                    raise PayloadTooLargeError(
                        f"PDF exceeds the {settings.max_pdf_size_mb} MB limit"
                    )
                if len(first) < 1024:
                    first += chunk[: 1024 - len(first)]
                tail = (tail + chunk)[-4096:]
                digest.update(chunk)
                destination.write(chunk)
        if size == 0:
            raise DomainError("PDF is empty")
        if not first.lstrip().startswith(b"%PDF-") or b"%%EOF" not in tail:
            raise UnsupportedMediaError("File is not a valid PDF")
        doi, title, authors, year = _metadata(path)
        return StoredPdf(
            original_filename=safe_display_filename(upload.filename),
            storage_key=key,
            file_size=size,
            sha256=digest.hexdigest(),
            detected_doi=doi,
            detected_title=title,
            detected_authors=authors,
            detected_year=year,
        )
    except Exception:
        path.unlink(missing_ok=True)
        raise
    finally:
        await upload.close()


def promote_pdf(
    staged_key: str, project_id: str, publication_id: str, document_id: str
) -> str:
    destination_key = (
        f"projects/{project_id}/publications/{publication_id}/{document_id}.pdf"
    )
    source = storage_path(staged_key)
    destination = storage_path(destination_key)
    destination.parent.mkdir(parents=True, exist_ok=True)
    os.replace(source, destination)
    return destination_key


def discard_pdf(storage_key: str | None) -> None:
    if storage_key:
        storage_path(storage_key).unlink(missing_ok=True)


def count_pdf_pages(storage_key: str, settings: Settings | None = None) -> int | None:
    try:
        reader = PdfReader(storage_path(storage_key, settings), strict=False)
        return len(reader.pages)
    except Exception:
        return None
