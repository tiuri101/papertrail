from sqlalchemy import select

from app.accounts.service import create_user
from app.deduplication.models import DuplicateCandidate, PublicationMerge
from app.deduplication.service import detect_duplicates, mark_not_duplicate, merge_publications, reverse_merge, transition_if_duplicate_review_complete
from app.projects.models import Project, ProjectStage, ReviewType
from app.publications.models import Publication, PublicationSource
from app.imports.models import ImportBatch, ImportedRecord, ImportStatus


def setup_records(db):
    admin = create_user(db, "admin", "Admin", "secret-password", is_admin=True)
    project = Project(name="Review", review_type=ReviewType.SYSTEMATIC_REVIEW, random_seed="seed", stage=ProjectStage.DUPLICATE_REVIEW)
    db.add(project); db.flush()
    batch = ImportBatch(project_id=project.id, original_filename="x.csv", stored_path="/tmp/x", file_type="csv", status=ImportStatus.COMPLETED, created_by_id=admin.id)
    db.add(batch); db.flush()
    imported = []
    publications = []
    for index, title in enumerate(["A Study of Urban VR", "A study of urban VR"]):
        record = ImportedRecord(import_batch_id=batch.id, source_row=index + 2, raw_data={}, parsed_data={"title": title}, validation_state="valid", warnings=[])
        publication = Publication(project_id=project.id, title=title, doi="10.1000/same" if index == 0 else "10.1000/same")
        db.add_all([record, publication]); db.flush()
        db.add(PublicationSource(publication_id=publication.id, imported_record_id=record.id))
        imported.append(record); publications.append(publication)
    db.commit()
    return project, publications


def test_detect_merge_and_reverse_duplicate(db) -> None:
    project, publications = setup_records(db)
    count = detect_duplicates(db, project.id)
    db.commit()
    assert count == 1
    candidate = db.scalar(select(DuplicateCandidate).where(DuplicateCandidate.project_id == project.id))
    assert candidate is not None
    assert "exact_doi" in candidate.match_reasons

    merge = merge_publications(db, candidate, publications[0].id)
    db.commit()
    assert publications[1].is_active is False
    assert publications[1].merged_into_id == publications[0].id
    assert len(publications[0].sources) == 2
    assert merge.reversed_at is None

    reverse_merge(db, merge)
    db.commit()
    assert publications[1].is_active is True
    assert publications[1].merged_into_id is None
    assert len(publications[0].sources) == 1
    assert merge.reversed_at is not None


def test_duplicate_review_only_transitions_when_all_candidates_resolved(db) -> None:
    project, _ = setup_records(db)
    detect_duplicates(db, project.id)
    db.commit()
    assert transition_if_duplicate_review_complete(db, project) is False
    candidate = db.scalar(select(DuplicateCandidate).where(DuplicateCandidate.project_id == project.id))
    mark_not_duplicate(candidate)
    assert transition_if_duplicate_review_complete(db, project) is True
    assert project.stage == ProjectStage.TITLE_ABSTRACT
