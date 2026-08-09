from __future__ import annotations

import shutil
from dataclasses import dataclass
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import Settings, get_settings
from app.imports.models import ImportBatch


def _contained_path(root: Path, *parts: str) -> Path:
    resolved_root = root.resolve()
    candidate = resolved_root.joinpath(*parts).resolve()
    if candidate == resolved_root or resolved_root not in candidate.parents:
        raise ValueError(
            "Refusing to remove a path outside its configured storage root"
        )
    return candidate


def _remove_tree(root: Path, *parts: str) -> None:
    candidate = _contained_path(root, *parts)
    if candidate.is_dir():
        shutil.rmtree(candidate)
    elif candidate.exists():
        candidate.unlink()


@dataclass(frozen=True)
class ProjectFileCleanup:
    project_id: str
    import_batch_ids: tuple[str, ...]

    @classmethod
    def collect(cls, db: Session, project_id: str) -> ProjectFileCleanup:
        batch_ids = tuple(
            db.scalars(
                select(ImportBatch.id).where(ImportBatch.project_id == project_id)
            )
        )
        return cls(project_id=project_id, import_batch_ids=batch_ids)

    def remove(self, settings: Settings | None = None) -> None:
        settings = settings or get_settings()
        _remove_tree(settings.pdf_storage_path, "projects", self.project_id)
        for batch_id in self.import_batch_ids:
            _remove_tree(settings.pdf_storage_path, "staging", "imports", batch_id)
        _remove_tree(settings.import_dir, self.project_id)
        _remove_tree(settings.export_dir, self.project_id)
