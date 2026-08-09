from __future__ import annotations

import re
from datetime import UTC, datetime
from itertools import combinations
from typing import Any

from rapidfuzz.fuzz import ratio
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.errors import ConflictError, NotFoundError
from app.deduplication.models import DuplicateCandidate, PublicationMerge
from app.fulltext.models import PublicationDocument
from app.jobs.service import enqueue_job
from app.projects.models import Project, ProjectStage
from app.publications.models import MetadataConflict, Publication, PublicationSource
from app.publications.service import IMPORTANT_FIELDS

UNIQUE_IDENTIFIER_FIELDS = ("pubmed_id", "arxiv_id")
CONTEXT_IDENTIFIER_FIELDS = ("isbn", "issn")

MERGE_FIELDS = (
    "title",
    "authors",
    "abstract",
    "publication_year",
    "venue",
    "publication_type",
    "doi",
    "publisher_url",
    "keywords",
    "isbn",
    "issn",
    "pubmed_id",
    "arxiv_id",
    "other_identifiers",
)


def normalized_title(title: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", title.lower()).strip()


def normalized_authors(authors: str | None) -> str:
    return re.sub(r"[^a-z0-9]+", " ", (authors or "").lower()).strip()


def _pair_key(left_id: str, right_id: str) -> tuple[str, str]:
    return (left_id, right_id) if left_id < right_id else (right_id, left_id)


def _duplicate_assessment(
    left: Publication, right: Publication
) -> tuple[list[str], float, float | None, bool | None, float | None]:
    title_score = float(
        ratio(normalized_title(left.title), normalized_title(right.title))
    )
    author_score = (
        float(
            ratio(normalized_authors(left.authors), normalized_authors(right.authors))
        )
        if left.authors and right.authors
        else None
    )
    year_agreement = (
        left.publication_year == right.publication_year
        if left.publication_year and right.publication_year
        else None
    )
    reasons: list[str] = []
    if left.doi and right.doi and left.doi == right.doi:
        reasons.append("exact_doi")
    for field in UNIQUE_IDENTIFIER_FIELDS:
        if getattr(left, field) and getattr(left, field) == getattr(right, field):
            reasons.append(f"exact_{field}")
    if normalized_title(left.title) == normalized_title(right.title):
        reasons.append("exact_title")
    elif title_score >= 92:
        reasons.append("similar_title")
    if title_score >= 90 and author_score is not None and author_score >= 80:
        reasons.append("similar_title_authors")
    if 80 <= title_score < 92 and year_agreement is True:
        reasons.append("similar_title_year")

    # ISBN identifies a book/proceedings volume and ISSN identifies a serial,
    # not an individual article. Keep them only as supporting context after an
    # independently useful publication-level match has already been found.
    if reasons:
        for field in CONTEXT_IDENTIFIER_FIELDS:
            if getattr(left, field) and getattr(left, field) == getattr(right, field):
                reasons.append(f"shared_{field}")

    if not reasons:
        return reasons, title_score, author_score, year_agreement, None
    strong_identifier_match = "exact_doi" in reasons or any(
        f"exact_{field}" in reasons for field in UNIQUE_IDENTIFIER_FIELDS
    )
    confidence = (
        1.0
        if strong_identifier_match
        else min(0.99, (title_score + (author_score or title_score)) / 200)
    )
    return reasons, title_score, author_score, year_agreement, confidence


def detect_duplicates(db: Session, project_id: str) -> int:
    publications = list(
        db.scalars(
            select(Publication)
            .where(
                Publication.project_id == project_id, Publication.is_active.is_(True)
            )
            .order_by(Publication.id)
        )
    )
    existing_candidates = {
        _pair_key(candidate.publication_a_id, candidate.publication_b_id): candidate
        for candidate in db.scalars(
            select(DuplicateCandidate).where(
                DuplicateCandidate.project_id == project_id
            )
        )
    }
    active_pairs: set[tuple[str, str]] = set()
    created = 0
    for left, right in combinations(publications, 2):
        a_id, b_id = _pair_key(left.id, right.id)
        pair = (a_id, b_id)
        active_pairs.add(pair)
        existing = existing_candidates.get(pair)
        if existing is not None and existing.status != "unresolved":
            continue
        (
            reasons,
            title_score,
            author_score,
            year_agreement,
            confidence,
        ) = _duplicate_assessment(left, right)
        if not reasons:
            if existing is not None:
                db.delete(existing)
            continue
        assert confidence is not None
        if existing is None:
            existing = DuplicateCandidate(
                project_id=project_id,
                publication_a_id=a_id,
                publication_b_id=b_id,
            )
            db.add(existing)
            created += 1
        existing.match_reasons = reasons
        existing.title_similarity = title_score
        existing.author_similarity = author_score
        existing.year_agreement = year_agreement
        existing.confidence = confidence

    for pair, candidate in existing_candidates.items():
        if candidate.status == "unresolved" and pair not in active_pairs:
            db.delete(candidate)
    db.flush()
    return created


def snapshot(publication: Publication) -> dict[str, Any]:
    return {field: getattr(publication, field) for field in MERGE_FIELDS} | {
        "is_active": publication.is_active,
        "merged_into_id": publication.merged_into_id,
    }


def merge_publications(
    db: Session,
    candidate: DuplicateCandidate,
    canonical_id: str,
    merged_by_id: str | None = None,
) -> PublicationMerge:
    if candidate.status != "unresolved":
        raise ConflictError("Duplicate candidate is already resolved")
    if canonical_id not in {candidate.publication_a_id, candidate.publication_b_id}:
        raise ConflictError("Canonical publication must belong to the candidate pair")
    merged_id = (
        candidate.publication_b_id
        if canonical_id == candidate.publication_a_id
        else candidate.publication_a_id
    )
    canonical = db.get(Publication, canonical_id)
    duplicate = db.get(Publication, merged_id)
    if canonical is None or duplicate is None:
        raise NotFoundError("Publication not found")
    canonical_before = snapshot(canonical)
    merged_before = snapshot(duplicate)
    conflicts_created = 0
    for field in MERGE_FIELDS:
        canonical_value = getattr(canonical, field)
        duplicate_value = getattr(duplicate, field)
        if canonical_value in (None, "", {}) and duplicate_value not in (
            None,
            "",
            {},
        ):
            setattr(canonical, field, duplicate_value)
        elif (
            field in IMPORTANT_FIELDS
            and canonical_value not in (None, "", {})
            and duplicate_value not in (None, "", {})
            and str(canonical_value).strip() != str(duplicate_value).strip()
        ):
            already = db.scalar(
                select(MetadataConflict.id).where(
                    MetadataConflict.publication_id == canonical.id,
                    MetadataConflict.field_name == field,
                    MetadataConflict.proposed_value == str(duplicate_value),
                    MetadataConflict.status == "open",
                )
            )
            if not already:
                db.add(
                    MetadataConflict(
                        publication_id=canonical.id,
                        field_name=field,
                        current_value=str(canonical_value),
                        proposed_value=str(duplicate_value),
                        source_name="merge",
                    )
                )
                conflicts_created += 1
    sources = list(
        db.scalars(
            select(PublicationSource).where(
                PublicationSource.publication_id == duplicate.id
            )
        )
    )
    moved_source_ids = [source.id for source in sources]
    for source in sources:
        source.publication_id = canonical.id
    canonical_active = db.scalar(
        select(PublicationDocument).where(
            PublicationDocument.publication_id == canonical.id,
            PublicationDocument.is_active.is_(True),
        )
    )
    duplicate_documents = list(
        db.scalars(
            select(PublicationDocument).where(
                PublicationDocument.publication_id == duplicate.id
            )
        )
    )
    moved_document_states = [
        {
            "id": document.id,
            "is_active": document.is_active,
            "replaced_by_document_id": document.replaced_by_document_id,
        }
        for document in duplicate_documents
    ]
    for document in duplicate_documents:
        document.publication_id = canonical.id
        if document.is_active and canonical_active is not None:
            document.is_active = False
            document.replaced_by_document_id = canonical_active.id
        elif document.is_active:
            canonical_active = document
    duplicate.is_active = False
    duplicate.merged_into_id = canonical.id
    candidate.status = "merged"
    candidate.resolved_by_id = merged_by_id
    merge = PublicationMerge(
        project_id=candidate.project_id,
        canonical_publication_id=canonical.id,
        merged_publication_id=duplicate.id,
        candidate_id=candidate.id,
        merged_by_id=merged_by_id,
        canonical_before=canonical_before,
        merged_before=merged_before,
        moved_source_ids=moved_source_ids,
        moved_document_states=moved_document_states,
    )
    db.add(merge)
    db.flush()
    db.refresh(canonical, ["sources"])
    return merge


def reverse_merge(
    db: Session, merge: PublicationMerge, reversed_by_id: str | None = None
) -> None:
    if merge.reversed_at is not None:
        raise ConflictError("Merge has already been reversed")
    canonical = db.get(Publication, merge.canonical_publication_id)
    duplicate = db.get(Publication, merge.merged_publication_id)
    if canonical is None or duplicate is None:
        raise NotFoundError("Merged publication no longer exists")
    for field, value in merge.canonical_before.items():
        setattr(canonical, field, value)
    for field, value in merge.merged_before.items():
        setattr(duplicate, field, value)
    # Clean up any still-open conflicts this merge created, so an undone
    # merge doesn't leave a dangling "proposed value" pointing at a
    # publication that's no longer merged in.
    open_merge_conflicts = list(
        db.scalars(
            select(MetadataConflict).where(
                MetadataConflict.publication_id == canonical.id,
                MetadataConflict.source_name == "merge",
                MetadataConflict.status == "open",
            )
        )
    )
    for conflict in open_merge_conflicts:
        merged_value = merge.merged_before.get(conflict.field_name)
        if merged_value is not None and str(merged_value) == conflict.proposed_value:
            db.delete(conflict)
    for source_id in merge.moved_source_ids:
        source = db.get(PublicationSource, source_id)
        if source:
            source.publication_id = duplicate.id
    for state in merge.moved_document_states:
        document = db.get(PublicationDocument, state["id"])
        if document:
            document.publication_id = duplicate.id
            document.is_active = state["is_active"]
            document.replaced_by_document_id = state["replaced_by_document_id"]
    if merge.candidate_id:
        candidate = db.get(DuplicateCandidate, merge.candidate_id)
        if candidate:
            candidate.status = "unresolved"
            candidate.resolved_by_id = None
    merge.reversed_at = datetime.now(UTC)
    merge.reversed_by_id = reversed_by_id
    db.flush()
    db.refresh(canonical, ["sources"])


def mark_not_duplicate(
    candidate: DuplicateCandidate,
    resolved_by_id: str | None = None,
    note: str | None = None,
) -> None:
    candidate.status = "not_duplicate"
    candidate.resolved_by_id = resolved_by_id
    candidate.resolution_note = note


def transition_if_duplicate_review_complete(db: Session, project: Project) -> bool:
    if project.stage != ProjectStage.DUPLICATE_REVIEW:
        return False
    db.flush()
    unresolved = (
        db.scalar(
            select(func.count())
            .select_from(DuplicateCandidate)
            .where(
                DuplicateCandidate.project_id == project.id,
                DuplicateCandidate.status == "unresolved",
            )
        )
        or 0
    )
    if unresolved:
        return False
    project.stage = ProjectStage.TITLE_ABSTRACT
    from app.projects.models import ScreeningStage
    from app.screening.service import create_screening_work_items

    create_screening_work_items(db, project, ScreeningStage.TITLE_ABSTRACT)

    from app.notifications.service import queue_project_stage_completed_emails

    queue_project_stage_completed_emails(
        db, project, ProjectStage.DUPLICATE_REVIEW, datetime.now(UTC)
    )
    enqueue_job(
        db,
        "generate_stage_analysis",
        {"stage": "duplicate_review"},
        project_id=project.id,
        created_by_id=None,
        priority=5,
    )
    db.flush()
    return True
