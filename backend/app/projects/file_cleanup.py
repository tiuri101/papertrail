"""Removing the files a deleted database row was the only pointer to.

PDF binaries, uploaded import sources and generated exports live on a
filesystem volume; the rows that name them live in PostgreSQL.  Deleting a
row therefore has to be paired with deleting its file, and the two cannot be
done atomically -- so the ordering is fixed and the same everywhere:

1. **collect** the paths while the rows naming them still exist,
2. **mutate and commit** the database,
3. **remove** the files.

Collecting first is what makes step 3 possible at all: once the ImportBatch
rows are gone, nothing remembers which staging directories belonged to this
project.  Removing last is what keeps a rolled-back transaction from having
destroyed files the surviving rows still point at.  The residue this ordering
can leave -- a crash between commit and removal -- is an orphaned file, which
wastes space but corrupts nothing; the opposite ordering leaves a row
pointing at a file that is already gone, which breaks reads.

For the same reason :meth:`ProjectFileCleanup.remove` never raises.  It runs
after the commit, so a failure there cannot undo anything and must not turn an
operation that already succeeded into a 500.  Failures are logged with the
exact path and returned to the caller, so an orphan is a reported orphan
rather than a silent one.
"""

from __future__ import annotations

import logging
import shutil
from dataclasses import dataclass
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import Settings, get_settings
from app.imports.models import ImportBatch

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class _Target:
    """One filesystem path to remove, plus the root it must live under.

    ``parts`` names a path built relative to ``root``; ``absolute`` is a path
    already recorded in the database (``ImportBatch.stored_path``) that is
    re-validated against the currently configured root rather than trusted.
    Either way nothing outside the root this process owns can be removed.
    """

    description: str
    root: Path
    parts: tuple[str, ...] | None = None
    absolute: str | None = None

    def resolve(self) -> Path:
        resolved_root = self.root.resolve()
        candidate = (
            Path(self.absolute).resolve()
            if self.absolute is not None
            else resolved_root.joinpath(*(self.parts or ())).resolve()
        )
        if candidate == resolved_root or resolved_root not in candidate.parents:
            raise ValueError(
                f"Refusing to remove {candidate}: outside its configured storage root"
            )
        return candidate


@dataclass(frozen=True)
class ProjectFileCleanup:
    """A resolved set of filesystem targets, safe to keep across a commit.

    Holds plain strings rather than ORM objects on purpose: it is built
    before the rows are deleted and used after they are gone, so it must not
    depend on a session that may have expired or detached them.
    """

    project_id: str
    # Whole-project trees -- only for operations that erase every publication,
    # import and export the project has (Delete Project, Reset Project).
    project_trees: bool = False
    # Per-import-batch PDF staging directories, holding PDFs that were never
    # attached to a publication. Attached PDFs have been promoted out of
    # staging into the project tree and belong to publication records, so
    # they are never removed here.
    import_batch_ids: tuple[str, ...] = ()
    # Absolute paths of uploaded import source files (ImportBatch.stored_path).
    import_file_paths: tuple[str, ...] = ()

    @classmethod
    def collect(cls, db: Session, project_id: str) -> ProjectFileCleanup:
        """Everything a project owns: PDFs, imports, staging and exports.

        Used by both Delete Project and Reset Project -- reset keeps the
        project row and its configuration but wipes every publication, import
        batch and export, so the files it orphans are exactly the same set.
        """
        batch_ids = tuple(
            db.scalars(
                select(ImportBatch.id).where(ImportBatch.project_id == project_id)
            )
        )
        return cls(
            project_id=project_id, project_trees=True, import_batch_ids=batch_ids
        )

    @classmethod
    def for_import_batches(
        cls, db: Session, project_id: str, batch_ids: list[str]
    ) -> ProjectFileCleanup:
        """Targets for deleting some of a project's imports, not all of it.

        Used by search deletion, which removes the import batches belonging
        to one documented search while the project -- and every other
        search's files -- stays. Covers each batch's uploaded source file and
        its staging directory of unresolved PDFs.
        """
        if not batch_ids:
            return cls(project_id=project_id)
        stored_paths = tuple(
            path
            for path in db.scalars(
                select(ImportBatch.stored_path).where(ImportBatch.id.in_(batch_ids))
            )
            if path
        )
        return cls(
            project_id=project_id,
            import_batch_ids=tuple(batch_ids),
            import_file_paths=stored_paths,
        )

    def _targets(self, settings: Settings) -> list[_Target]:
        targets: list[_Target] = []
        if self.project_trees:
            targets += [
                _Target(
                    f"pdfs/projects/{self.project_id}",
                    settings.pdf_storage_path,
                    ("projects", self.project_id),
                ),
                _Target(
                    f"imports/{self.project_id}",
                    settings.import_dir,
                    (self.project_id,),
                ),
                _Target(
                    f"exports/{self.project_id}",
                    settings.export_dir,
                    (self.project_id,),
                ),
            ]
        targets += [
            _Target(
                f"pdfs/staging/imports/{batch_id}",
                settings.pdf_storage_path,
                ("staging", "imports", batch_id),
            )
            for batch_id in self.import_batch_ids
        ]
        targets += [
            _Target(stored_path, settings.import_dir, absolute=stored_path)
            for stored_path in self.import_file_paths
        ]
        return targets

    def remove(self, settings: Settings | None = None) -> list[str]:
        """Delete every collected target; return the ones that failed.

        Never raises (see the module docstring). Each target is attempted
        independently, so one failure cannot strand the rest.
        """
        settings = settings or get_settings()
        failures: list[str] = []
        for target in self._targets(settings):
            try:
                candidate = target.resolve()
            except ValueError:
                logger.exception(
                    "Refusing to clean up %s: it does not resolve inside its "
                    "configured storage root",
                    target.description,
                )
                failures.append(target.description)
                continue
            try:
                if candidate.is_dir():
                    shutil.rmtree(candidate)
                elif candidate.exists():
                    candidate.unlink()
            except OSError:
                logger.exception(
                    "Could not remove %s after its database rows were deleted; "
                    "the file is now orphaned and needs manual cleanup",
                    candidate,
                )
                failures.append(str(candidate))
        return failures
