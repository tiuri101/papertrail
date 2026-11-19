"""How a project's identified records flow into its unique publications.

PRISMA's identification and deduplication boxes ("records identified",
"duplicates removed", and the unique records that remain) are derived here
from the review *as it currently stands*, never from historical bookkeeping.
Merge rows and imported records are kept as history after a search is
deleted or a publication is removed from the review, so counting them
directly makes the flow stop adding up: a deleted search's records vanish
from "identified" while the merges they took part in stayed "removed
duplicates", and a deleted paper's record stayed "identified" while it was
neither screened nor a duplicate.

The rule instead: every *live* publication -- an active one -- stands for a
set of identified records (the imported search records it holds now, or
itself when it was added by hand, plus any hand-added publications merged
into it). One of those records is the unique record; the rest are the
duplicates removed. A publication removed from the review, together with
everything merged into it, contributes nothing at all.

Imported records that never became publications -- rows without a title --
are identified and then "removed before screening for other reasons", as
PRISMA 2020 provides for; rows of an import that hasn't finished are not
counted yet. Records of an import that names no documented search count as
identified through other sources.

So ``identified - duplicates removed - removed for other reasons`` is always
the number of publications in the review, and deleting anything moves every
box consistently.
"""

from __future__ import annotations

from collections import Counter, defaultdict
from dataclasses import dataclass, field

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.deduplication.models import PublicationMerge
from app.imports.models import ImportBatch, ImportedRecord, ImportStatus
from app.publications.models import Publication, PublicationSource


@dataclass(frozen=True)
class RecordFlow:
    database_records: int
    other_records: int
    duplicates_removed: int
    # Identified records that never became publications (invalid rows).
    removed_other: int
    # Candidates of the merges that account for ``duplicates_removed`` -- for
    # breaking the removed duplicates down by match reason.
    counted_merge_candidate_ids: list[str] = field(default_factory=list)


def calculate_record_flow(db: Session, project_id: str) -> RecordFlow:
    publications = db.execute(
        select(Publication.id, Publication.is_active, Publication.merged_into_id).where(
            Publication.project_id == project_id
        )
    ).all()
    active = {publication_id for publication_id, is_active, _ in publications if is_active}

    merges = db.execute(
        select(
            PublicationMerge.canonical_publication_id,
            PublicationMerge.merged_publication_id,
            PublicationMerge.candidate_id,
            PublicationMerge.moved_source_ids,
        )
        .where(
            PublicationMerge.project_id == project_id,
            PublicationMerge.reversed_at.is_(None),
        )
        .order_by(PublicationMerge.created_at, PublicationMerge.id)
    ).all()

    # Where each merged-away publication went. The standing merge row is
    # authoritative; ``merged_into_id`` covers rows without one.
    parent: dict[str, str] = {
        publication_id: merged_into
        for publication_id, is_active, merged_into in publications
        if not is_active and merged_into
    }
    for canonical_id, merged_id, _candidate, _moved in merges:
        if merged_id not in active:
            parent[merged_id] = canonical_id

    def live_root(publication_id: str) -> str | None:
        """The active publication a record ultimately belongs to, or None
        when its chain ends in a publication removed from the review."""
        seen: set[str] = set()
        current = publication_id
        while current not in active:
            if current in seen or current not in parent:
                return None
            seen.add(current)
            current = parent[current]
        return current

    # Records each live publication stands for.
    units: Counter[str] = Counter()

    record_rows = db.execute(
        select(
            ImportedRecord.id,
            ImportBatch.search_source_id,
            ImportBatch.status,
            PublicationSource.publication_id,
        )
        .join(ImportBatch, ImportBatch.id == ImportedRecord.import_batch_id)
        .outerjoin(
            PublicationSource, PublicationSource.imported_record_id == ImportedRecord.id
        )
        .where(ImportBatch.project_id == project_id)
    ).all()
    records: dict[str, tuple[bool, bool, list[str]]] = {}
    for record_id, search_source_id, batch_status, publication_id in record_rows:
        from_search, completed, held_by = records.setdefault(
            record_id,
            (search_source_id is not None, batch_status == ImportStatus.COMPLETED, []),
        )
        if publication_id is not None:
            held_by.append(publication_id)

    database_records = 0
    other_records = 0
    removed_other = 0
    for from_search, completed, held_by in records.values():
        if held_by:
            root = next((r for r in map(live_root, held_by) if r is not None), None)
            if root is None:
                # Its publication was removed from the review.
                continue
            units[root] += 1
        elif completed:
            # A finished import's record that never became a publication
            # (e.g. a row without a title): identified, then removed before
            # screening for a reason other than being a duplicate.
            removed_other += 1
        else:
            # An import still running (or that failed part-way) has stored
            # rows it hasn't turned into publications yet; they aren't part
            # of the review until it does.
            continue
        # An import that names no documented search still identified its
        # records -- just not through database searching.
        if from_search:
            database_records += 1
        else:
            other_records += 1

    source_rows = db.execute(
        select(PublicationSource.id, PublicationSource.publication_id)
        .join(ImportedRecord, ImportedRecord.id == PublicationSource.imported_record_id)
        .join(ImportBatch, ImportBatch.id == ImportedRecord.import_batch_id)
        .where(ImportBatch.project_id == project_id)
    ).all()
    existing_source_ids = {source_id for source_id, _ in source_rows}
    sourced_publications = {publication_id for _, publication_id in source_rows}

    # Publications added without any import are each one identified record.
    for publication_id in active:
        if publication_id not in sourced_publications:
            units[publication_id] += 1
            other_records += 1

    # A merge moves the duplicate's sources -- including any it had itself
    # received from earlier merges -- so a merge's *own* records are its moved
    # sources minus those that arrived through merges into its duplicate.
    received: dict[str, set[str]] = defaultdict(set)
    for canonical_id, _merged, _candidate, moved in merges:
        received[canonical_id].update(moved or [])

    standing: dict[str, list[str | None]] = defaultdict(list)
    for _canonical, merged_id, candidate_id, moved in merges:
        root = live_root(merged_id)
        if root is None or merged_id in active:
            continue
        own_sources = set(moved or []) - received[merged_id]
        if not own_sources:
            # A hand-added publication merged away: an identified record of
            # its own, removed as a duplicate.
            units[root] += 1
            other_records += 1
            standing[root].append(candidate_id)
        elif own_sources & existing_source_ids:
            standing[root].append(candidate_id)

    duplicates_removed = 0
    counted: list[str] = []
    for root, count in units.items():
        removed_here = max(count - 1, 0)
        duplicates_removed += removed_here
        # A merge whose kept record's own records were deleted no longer
        # removes anything, so only as many merges count as duplicates this
        # publication actually absorbed (oldest first).
        counted.extend(
            candidate_id
            for candidate_id in standing[root][:removed_here]
            if candidate_id is not None
        )

    return RecordFlow(
        database_records=database_records,
        other_records=other_records,
        duplicates_removed=duplicates_removed,
        removed_other=removed_other,
        counted_merge_candidate_ids=counted,
    )
