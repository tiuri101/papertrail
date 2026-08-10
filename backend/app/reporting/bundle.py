from __future__ import annotations

import zipfile
from io import BytesIO

from sqlalchemy.orm import Session

from app.fulltext.documents import active_document
from app.fulltext.storage import storage_path
from app.reporting.bibtex import build_bibtex_for_publications, publications_for_scope


def build_publication_bundle(
    db: Session, project_id: str, publication_ids: list[str]
) -> bytes:
    """Build a zip with one combined metadata.bib and each publication's PDF.

    PDF files are named after their BibTeX citation key so a .bib entry and
    its matching PDF share a filename. Publications without an attached (or
    readable) PDF are skipped and listed in MISSING_PDFS.txt instead.
    """
    publications = publications_for_scope(
        db, project_id, "selected", None, publication_ids
    )
    bibtex_text, keys = build_bibtex_for_publications(publications)
    missing: list[str] = []
    buffer = BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("metadata.bib", bibtex_text)
        for publication in publications:
            document = active_document(db, publication.id)
            path = storage_path(document.storage_key) if document else None
            if path is None or not path.is_file():
                missing.append(publication.title or publication.id)
                continue
            archive.write(path, arcname=f"{keys[publication.id]}.pdf")
        if missing:
            archive.writestr(
                "MISSING_PDFS.txt",
                "The following publications had no PDF attached and were skipped:\n\n"
                + "\n".join(missing)
                + "\n",
            )
    return buffer.getvalue()
