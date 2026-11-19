"""Statistics must describe the review as it stands after records leave it.

Deleting a search, or deleting individual publications, removes papers from
the active review. Every count derived from the review -- PRISMA flow,
duplicate-review statistics, reviewer statistics, extraction/quality field
statistics, and the projects-overview card -- must then agree that those
papers are gone: they are no longer identified, no longer duplicates of
anything, and no longer screened or assessed evidence.
"""

from __future__ import annotations

from datetime import date

from sqlalchemy import select

from app.accounts.service import create_user
from app.analysis.reviewer_service import compute_reviewer_summary
from app.analysis.service import (
    compute_duplicate_review_stats,
    compute_extraction_stats,
)
from app.deduplication.models import DuplicateCandidate
from app.deduplication.service import duplicate_review_progress, merge_publications
from app.imports.models import ImportBatch, ImportedRecord, ImportStatus, SearchSource
from app.imports.service import preview_or_delete_search
from app.projects.models import (
    Project,
    ProjectStage,
    ReviewType,
    ScreeningStage,
)
from app.projects.service import project_progress_stats
from app.publications.deletion import remove_publications_from_review
from app.publications.models import Publication, PublicationSource
from app.quality.models import QualityResponse, QualityWorkItem
from app.reporting.prisma import calculate_prisma_counts
from app.screening.models import ScreeningOutcome
from tests.test_analysis import _seed_extraction_project
from tests.test_reviewer_analysis import make_decision
from tests.test_reviewer_analysis import make_project as make_screening_project


def _project(db, stage: ProjectStage = ProjectStage.DUPLICATE_REVIEW) -> Project:
    project = Project(
        name="Review",
        review_type=ReviewType.SYSTEMATIC_REVIEW,
        random_seed="seed",
        stage=stage,
    )
    db.add(project)
    db.flush()
    return project


def _search(db, project, owner, name, titles) -> tuple[SearchSource, list[Publication]]:
    """A documented database search whose import produced one publication per title."""
    search = SearchSource(
        project_id=project.id,
        source_name=name,
        query="q",
        search_date=date(2026, 1, 1),
        exported_result_count=len(titles),
        created_by_id=owner.id,
    )
    db.add(search)
    db.flush()
    batch = ImportBatch(
        project_id=project.id,
        search_source_id=search.id,
        original_filename=f"{name}.csv",
        stored_path="/tmp/x",
        file_type="csv",
        status=ImportStatus.COMPLETED,
        created_by_id=owner.id,
    )
    db.add(batch)
    db.flush()
    publications = []
    for index, title in enumerate(titles):
        record = ImportedRecord(
            import_batch_id=batch.id,
            source_row=index + 2,
            raw_data={},
            parsed_data={"title": title},
            validation_state="valid",
            warnings=[],
        )
        publication = Publication(project_id=project.id, title=title)
        db.add_all([record, publication])
        db.flush()
        db.add(
            PublicationSource(
                publication_id=publication.id, imported_record_id=record.id
            )
        )
        publications.append(publication)
    db.flush()
    return search, publications


def _merge(db, project, canonical, duplicate, reasons=("exact_title",)):
    candidate = DuplicateCandidate(
        project_id=project.id,
        publication_a_id=canonical.id,
        publication_b_id=duplicate.id,
        match_reasons=list(reasons),
        confidence=0.95,
    )
    db.add(candidate)
    db.flush()
    return merge_publications(db, candidate, canonical.id)


def _overlapping_searches(db):
    """Search A: one, two. Search B: one (duplicate of A's), three."""
    owner = create_user(db, "owner", "Owner", "long-password-1")
    project = _project(db)
    search_a, (a_one, _a_two) = _search(db, project, owner, "A", ["Paper one", "Paper two"])
    search_b, (b_one, _b_three) = _search(
        db, project, owner, "B", ["Paper one", "Paper three"]
    )
    return project, search_a, search_b, a_one, b_one


def _flow(db, project_id):
    counts = calculate_prisma_counts(db, project_id)
    identified = (
        counts["recordsIdentifiedDatabases"] + counts["recordsIdentifiedOtherSources"]
    )
    return counts, identified, identified - counts["duplicatesRemoved"]


def _active_count(db, project_id) -> int:
    return len(
        db.scalars(
            select(Publication.id).where(
                Publication.project_id == project_id, Publication.is_active.is_(True)
            )
        ).all()
    )


def test_deleting_a_search_drops_the_duplicates_its_records_were_part_of(db) -> None:
    project, _search_a, search_b, a_one, b_one = _overlapping_searches(db)
    _merge(db, project, canonical=a_one, duplicate=b_one)
    db.commit()
    counts, identified, unique = _flow(db, project.id)
    assert (identified, counts["duplicatesRemoved"], unique) == (4, 1, 3)

    db.refresh(search_b)
    preview_or_delete_search(db, search_b, force=True)
    db.commit()

    counts, identified, unique = _flow(db, project.id)
    assert identified == 2
    assert counts["duplicatesRemoved"] == 0
    assert unique == _active_count(db, project.id) == 2
    stats = compute_duplicate_review_stats(db, project.id)
    assert stats["duplicatesRemoved"] == 0
    assert stats["uniqueRecordsRemaining"] == 2
    assert stats["matchReasonCounts"] == []


def test_deleting_the_search_of_a_kept_canonical_record_drops_the_duplicate(
    db,
) -> None:
    """B's copy was kept and A's merged into it; deleting B leaves the paper
    in the review (it is still one of A's results) but it is no longer a
    duplicate of anything."""
    project, _search_a, search_b, a_one, b_one = _overlapping_searches(db)
    _merge(db, project, canonical=b_one, duplicate=a_one)
    db.commit()

    db.refresh(search_b)
    preview_or_delete_search(db, search_b, force=True)
    db.commit()

    counts, identified, unique = _flow(db, project.id)
    assert identified == 2
    assert counts["duplicatesRemoved"] == 0
    assert unique == _active_count(db, project.id) == 2
    assert compute_duplicate_review_stats(db, project.id)["matchReasonCounts"] == []


def test_deleted_publications_drop_out_of_records_identified(db) -> None:
    project, _search_a, _search_b, _a_one, b_one = _overlapping_searches(db)
    db.commit()

    remove_publications_from_review(db, project.id, [b_one])
    db.commit()

    counts, identified, unique = _flow(db, project.id)
    assert identified == 3
    assert counts["duplicatesRemoved"] == 0
    assert unique == _active_count(db, project.id) == 3


def test_deleting_a_canonical_record_drops_it_and_its_merged_duplicate(db) -> None:
    project, _search_a, _search_b, a_one, b_one = _overlapping_searches(db)
    _merge(db, project, canonical=a_one, duplicate=b_one)
    db.commit()

    remove_publications_from_review(db, project.id, [a_one])
    db.commit()

    counts, identified, unique = _flow(db, project.id)
    assert identified == 2
    assert counts["duplicatesRemoved"] == 0
    assert unique == _active_count(db, project.id) == 2
    assert compute_duplicate_review_stats(db, project.id)["matchReasonCounts"] == []


def test_chained_merges_still_count_every_removed_duplicate(db) -> None:
    owner = create_user(db, "owner", "Owner", "long-password-1")
    project = _project(db)
    _source, (first, second, third) = _search(
        db, project, owner, "A", ["Paper", "Paper", "Paper"]
    )
    _merge(db, project, canonical=second, duplicate=first)
    _merge(db, project, canonical=third, duplicate=second)
    db.commit()

    counts, identified, unique = _flow(db, project.id)
    assert identified == 3
    assert counts["duplicatesRemoved"] == 2
    assert unique == 1
    stats = compute_duplicate_review_stats(db, project.id)
    assert stats["matchReasonCounts"] == [{"label": "exact_title", "count": 2}]


def test_removing_a_publication_retracts_its_unresolved_duplicate_pairs(db) -> None:
    project, _search_a, _search_b, a_one, b_one = _overlapping_searches(db)
    db.add(
        DuplicateCandidate(
            project_id=project.id,
            publication_a_id=a_one.id,
            publication_b_id=b_one.id,
            match_reasons=["exact_title"],
            confidence=0.95,
        )
    )
    db.commit()
    assert duplicate_review_progress(db, project.id)["remaining"] == 1

    remove_publications_from_review(db, project.id, [b_one])
    db.commit()

    assert duplicate_review_progress(db, project.id)["remaining"] == 0


def test_reviewer_summary_ignores_decisions_on_removed_publications(db) -> None:
    project = make_screening_project(db)
    r1 = create_user(db, "r1", "R1", "long-password-1")
    r2 = create_user(db, "r2", "R2", "long-password-2")
    kept = Publication(project_id=project.id, title="Kept")
    removed = Publication(project_id=project.id, title="Removed")
    db.add_all([kept, removed])
    db.flush()
    for publication in (kept, removed):
        for slot, reviewer in ((1, r1), (2, r2)):
            make_decision(
                db,
                project,
                publication,
                ScreeningStage.TITLE_ABSTRACT,
                reviewer,
                ScreeningOutcome.INCLUDE,
                slot_number=slot,
            )
    db.commit()

    remove_publications_from_review(db, project.id, [removed])
    db.commit()

    summary = compute_reviewer_summary(db, project.id)
    assert [entry["titleAbstractCount"] for entry in summary] == [1, 1]


def _quality_answered_publication(db, project_id: str) -> Publication:
    response = db.scalars(
        select(QualityResponse)
        .join(QualityWorkItem)
        .where(QualityWorkItem.project_id == project_id)
        .where(QualityResponse.is_current.is_(True))
    ).all()
    answered = next(item for item in response if item.answers)
    publication = db.get(Publication, answered.work_item.publication_id)
    assert publication is not None
    return publication


def test_quality_statistics_ignore_removed_publications(db) -> None:
    project = _seed_extraction_project(db)
    removed = _quality_answered_publication(db, project.id)

    remove_publications_from_review(db, project.id, [removed])
    db.commit()

    stats = compute_extraction_stats(db, project.id)
    risk = next(field for field in stats["fields"] if field["label"] == "Risk of bias")
    assert risk["totalCount"] == 2
    assert risk["answeredCount"] == 1


def test_project_card_ignores_removed_publications(db) -> None:
    project = _seed_extraction_project(db)
    removed = db.scalars(
        select(Publication).where(Publication.project_id == project.id)
    ).first()

    remove_publications_from_review(db, project.id, [removed])
    # Shown as extraction progress; set after the removal so stage settling
    # (which owns completion) doesn't interfere with what this test checks.
    project.stage = ProjectStage.EXTRACTION
    db.commit()

    card = project_progress_stats(db, [project])[project.id]
    assert card["secondary_label"] == "Extracted"
    assert card["secondary_count"] == 2
    assert card["percent_complete"] == 100


def test_project_card_duplicate_counts_ignore_removed_publications(db) -> None:
    project, _search_a, _search_b, a_one, b_one = _overlapping_searches(db)
    _merge(db, project, canonical=a_one, duplicate=b_one)
    db.commit()
    assert project_progress_stats(db, [project])[project.id]["secondary_count"] == 1

    remove_publications_from_review(db, project.id, [a_one])
    db.commit()

    assert project_progress_stats(db, [project])[project.id]["secondary_count"] == 0


def _add_record(db, batch, row, *, valid=True, publication=None) -> None:
    record = ImportedRecord(
        import_batch_id=batch.id,
        source_row=row,
        raw_data={},
        parsed_data={"title": "Paper"} if valid else {},
        validation_state="valid" if valid else "invalid",
        warnings=[] if valid else ["Missing title"],
    )
    db.add(record)
    db.flush()
    if publication is not None:
        db.add(
            PublicationSource(
                publication_id=publication.id, imported_record_id=record.id
            )
        )
        db.flush()


def test_invalid_rows_are_identified_then_removed_before_screening(db) -> None:
    owner = create_user(db, "owner", "Owner", "long-password-1")
    project = _project(db)
    search, _papers = _search(db, project, owner, "A", ["Paper one", "Paper two"])
    batch = search.import_batches[0]
    _add_record(db, batch, 10, valid=False)
    db.commit()

    counts, identified, unique = _flow(db, project.id)
    assert identified == 3
    assert counts["duplicatesRemoved"] == 0
    assert counts["recordsRemovedOther"] == 1
    assert unique - counts["recordsRemovedOther"] == _active_count(db, project.id) == 2
    stats = compute_duplicate_review_stats(db, project.id)
    assert stats["recordsRemovedOther"] == 1
    assert stats["uniqueRecordsRemaining"] == 2


def test_records_of_an_unfinished_import_are_not_identified_yet(db) -> None:
    owner = create_user(db, "owner", "Owner", "long-password-1")
    project = _project(db)
    search, _papers = _search(db, project, owner, "A", ["Paper one"])
    in_flight = ImportBatch(
        project_id=project.id,
        search_source_id=search.id,
        original_filename="more.csv",
        stored_path="/tmp/y",
        file_type="csv",
        status=ImportStatus.PROCESSING,
        created_by_id=owner.id,
    )
    db.add(in_flight)
    db.flush()
    _add_record(db, in_flight, 2)
    _add_record(db, in_flight, 3, valid=False)
    db.commit()

    counts, identified, _unique = _flow(db, project.id)
    assert identified == 1
    assert counts["recordsRemovedOther"] == 0


def test_records_imported_without_a_search_count_as_other_sources(db) -> None:
    owner = create_user(db, "owner", "Owner", "long-password-1")
    project = _project(db)
    _search(db, project, owner, "A", ["Paper one"])
    undocumented = ImportBatch(
        project_id=project.id,
        search_source_id=None,
        original_filename="legacy.csv",
        stored_path="/tmp/z",
        file_type="csv",
        status=ImportStatus.COMPLETED,
        created_by_id=owner.id,
    )
    db.add(undocumented)
    db.flush()
    legacy = Publication(project_id=project.id, title="Legacy paper")
    db.add(legacy)
    db.flush()
    _add_record(db, undocumented, 2, publication=legacy)
    _add_record(db, undocumented, 3, valid=False)
    db.commit()

    counts, identified, unique = _flow(db, project.id)
    assert counts["recordsIdentifiedDatabases"] == 1
    assert counts["recordsIdentifiedOtherSources"] == 2
    assert counts["recordsRemovedOther"] == 1
    assert unique - counts["recordsRemovedOther"] == _active_count(db, project.id) == 2
