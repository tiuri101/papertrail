from __future__ import annotations

import hashlib
import io
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


@dataclass(frozen=True)
class DetectedPdf:
    """The same metadata :class:`StoredPdf` carries, without writing
    anything to disk. Used where a caller only needs to know what a PDF
    *is* -- e.g. to look up a matching publication -- before deciding
    whether it's worth staging at all."""

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


def _metadata_from_reader(
    reader: PdfReader,
) -> tuple[str | None, str | None, str | None, int | None]:
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


def _metadata(path: Path) -> tuple[str | None, str | None, str | None, int | None]:
    try:
        reader = PdfReader(path, strict=False)
    except Exception as exc:
        raise UnsupportedMediaError("File is not a valid PDF") from exc
    return _metadata_from_reader(reader)


def _metadata_from_bytes(
    data: bytes,
) -> tuple[str | None, str | None, str | None, int | None]:
    try:
        reader = PdfReader(io.BytesIO(data), strict=False)
    except Exception as exc:
        raise UnsupportedMediaError("File is not a valid PDF") from exc
    return _metadata_from_reader(reader)


@dataclass(frozen=True)
class _StagingKey:
    """Precomputed destination for a staged upload, before any bytes are read."""

    original_filename: str
    storage_key: str
    path: Path
    limit: int


def _prepare_staging(
    filename: str | None,
    *,
    import_batch_id: str,
    settings: Settings,
) -> _StagingKey:
    safe_name = safe_display_filename(filename)
    limit = settings.max_pdf_size_mb * 1024 * 1024
    key = f"staging/imports/{import_batch_id}/{uuid4()}.pdf"
    path = storage_path(key, settings)
    path.parent.mkdir(parents=True, exist_ok=True)
    return _StagingKey(
        original_filename=safe_name, storage_key=key, path=path, limit=limit
    )


def _validate_staged_pdf(*, size: int, first: bytes, tail: bytes) -> None:
    """Validate a fully-read staged file's header/trailer once the size-limit
    check (which happens mid-stream, inside each reader's own read loop) has
    already passed."""
    if size == 0:
        raise DomainError("PDF is empty")
    if not first.lstrip().startswith(b"%PDF-") or b"%%EOF" not in tail:
        raise UnsupportedMediaError("File is not a valid PDF")


def _finalize_staged_pdf(staging: _StagingKey, *, size: int, digest: Any) -> StoredPdf:
    doi, title, authors, year = _metadata(staging.path)
    return StoredPdf(
        original_filename=staging.original_filename,
        storage_key=staging.storage_key,
        file_size=size,
        sha256=digest.hexdigest(),
        detected_doi=doi,
        detected_title=title,
        detected_authors=authors,
        detected_year=year,
    )


def _stage_stream(
    stream: IO[bytes],
    filename: str | None,
    *,
    import_batch_id: str,
    settings: Settings,
) -> StoredPdf:
    staging = _prepare_staging(
        filename, import_batch_id=import_batch_id, settings=settings
    )
    digest = hashlib.sha256()
    size = 0
    first = b""
    tail = b""
    try:
        with staging.path.open("xb") as destination:
            while chunk := stream.read(1024 * 1024):
                size += len(chunk)
                if size > staging.limit:
                    raise PayloadTooLargeError(
                        f"PDF exceeds the {settings.max_pdf_size_mb} MB limit"
                    )
                if len(first) < 1024:
                    first += chunk[: 1024 - len(first)]
                tail = (tail + chunk)[-4096:]
                digest.update(chunk)
                destination.write(chunk)
        _validate_staged_pdf(size=size, first=first, tail=tail)
        return _finalize_staged_pdf(staging, size=size, digest=digest)
    except Exception:
        staging.path.unlink(missing_ok=True)
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
    staging = _prepare_staging(
        upload.filename, import_batch_id=import_batch_id, settings=settings
    )
    digest = hashlib.sha256()
    size = 0
    first = b""
    tail = b""
    try:
        with staging.path.open("xb") as destination:
            while chunk := await upload.read(1024 * 1024):
                size += len(chunk)
                if size > staging.limit:
                    raise PayloadTooLargeError(
                        f"PDF exceeds the {settings.max_pdf_size_mb} MB limit"
                    )
                if len(first) < 1024:
                    first += chunk[: 1024 - len(first)]
                tail = (tail + chunk)[-4096:]
                digest.update(chunk)
                destination.write(chunk)
        _validate_staged_pdf(size=size, first=first, tail=tail)
        return _finalize_staged_pdf(staging, size=size, digest=digest)
    except Exception:
        staging.path.unlink(missing_ok=True)
        raise
    finally:
        await upload.close()


async def detect_pdf_upload(
    upload: UploadFile,
    *,
    settings: Settings | None = None,
) -> DetectedPdf:
    """Read and validate an uploaded PDF entirely in memory, without staging
    it to disk. Mirrors :func:`stage_pdf_upload`'s size/header/trailer
    validation and DOI/title extraction, for callers (e.g. the browser
    extension's manual-capture flow) that need to know what a PDF is before
    committing to store it -- staging happens separately, only once a
    destination publication has been chosen."""
    settings = settings or get_settings()
    limit = settings.max_pdf_size_mb * 1024 * 1024
    digest = hashlib.sha256()
    size = 0
    first = b""
    tail = b""
    buffer = bytearray()
    try:
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
            buffer.extend(chunk)
        _validate_staged_pdf(size=size, first=first, tail=tail)
        doi, title, authors, year = _metadata_from_bytes(bytes(buffer))
        return DetectedPdf(
            file_size=size,
            sha256=digest.hexdigest(),
            detected_doi=doi,
            detected_title=title,
            detected_authors=authors,
            detected_year=year,
        )
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
