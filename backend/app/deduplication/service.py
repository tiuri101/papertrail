from __future__ import annotations

import re
from collections import defaultdict
from datetime import UTC, datetime, timedelta
from itertools import combinations
from typing import Any, TypeVar

from rapidfuzz.fuzz import ratio
from sqlalchemy import Select, func, or_, select
from sqlalchemy.orm import Session, joinedload

from app.api.errors import ConflictError, NotFoundError
from app.audit.service import record_audit
from app.deduplication.models import DuplicateCandidate, PublicationMerge
from app.fulltext.models import PublicationDocument
from app.jobs.service import enqueue_job
from app.projects.models import Project, ProjectStage, ScreeningStage
from app.publications.models import (
    ConflictStatus,
    MetadataConflict,
    Publication,
    PublicationSource,
)
from app.publications.service import IMPORTANT_FIELDS, values_conflict
from app.screening.models import ScreeningDecision, ScreeningWorkItem

UNIQUE_IDENTIFIER_FIELDS = ("pubmed_id", "arxiv_id")
CONTEXT_IDENTIFIER_FIELDS = ("isbn", "issn")

#: _duplicate_assessment only ever scores a pair at 1.0 when the pair shares
#: an exact DOI/PubMed ID/arXiv ID (see "strong_identifier_match" below) --
#: i.e. an "exact match" in the sense a reviewer wouldn't need to eyeball, as
#: opposed to an identical title (capped at 0.99) or any fuzzy match. Only
#: these pairs are safe to resolve automatically.
AUTO_MERGE_CONFIDENCE = 1.0

#: How long a claimed-but-undecided candidate stays hidden from other
#: reviewers working the duplicate-review queue. Matches the reviewer-queue
#: reservation window used by screening / extraction / quality.
RESERVATION_HOURS = 1

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


# --------------------------------------------------------------------------
# Candidate-pair generation (blocking)
# --------------------------------------------------------------------------
#
# Comparing every publication against every other one is O(n^2): a 5,000-
# record systematic review would need ~12.5 million rapidfuzz calls. Instead,
# publications are grouped into cheap "blocks" -- publications that could
# plausibly be the same record -- and only pairs that land in a shared block
# ever reach the expensive fuzzy comparison in _duplicate_assessment.
#
# Blocking keys, chosen to mirror the match reasons _duplicate_assessment can
# actually produce, so blocking narrows the search space without discarding
# a pair that could otherwise be flagged:
#   * an exact identifier (DOI, PubMed ID, arXiv ID) -- covers "exact_*";
#   * a handful of the longest, least-common title words -- covers
#     "exact_title"/"similar_title"/"similar_title_authors", including
#     reordered or lightly-edited titles, since genuine near-duplicates
#     almost always still share several long, distinctive words;
#   * (year, first title word) -- a coarse net that also catches short or
#     heavily-reworded titles sharing only their opening word and year,
#     covering "similar_title_year".
# A publication with no usable title text (blank/whitespace-only) still gets
# whatever identifier keys it has; it simply cannot be title-blocked, which
# matches _duplicate_assessment's own behavior (no title, no title score).

#: Common words carry no distinguishing power and would put a large fraction
#: of the project into one block, defeating the point of blocking.
_TITLE_STOPWORDS = frozenset(
    {
        "the", "a", "an", "of", "and", "for", "with", "from", "using", "into",
        "this", "that", "study", "review", "analysis", "systematic", "based",
        "effects", "effect", "among", "between", "during", "after", "before",
        "their", "which", "when", "what", "randomized", "controlled", "trial",
    }
)
#: Longest-title-words considered per publication. Bounds how many blocks one
#: publication can join, which in turn bounds worst-case block fan-out.
_MAX_TITLE_BLOCK_TOKENS = 6


def _title_block_tokens(title: str) -> list[str]:
    tokens = {token for token in normalized_title(title).split() if len(token) >= 4}
    tokens -= _TITLE_STOPWORDS
    return sorted(tokens, key=len, reverse=True)[:_MAX_TITLE_BLOCK_TOKENS]


def _blocking_keys(publication: Publication) -> set[tuple[str, Any]]:
    keys: set[tuple[str, Any]] = set()
    if publication.doi:
        keys.add(("doi", publication.doi.strip().lower()))
    for field in UNIQUE_IDENTIFIER_FIELDS:
        value = getattr(publication, field)
        if value:
            keys.add((field, value))
    title = publication.title or ""
    for token in _title_block_tokens(title):
        keys.add(("title_token", token))
    normalized = normalized_title(title)
    first_word = normalized.split()[0] if normalized else None
    if first_word and publication.publication_year:
        keys.add(("year_first_word", (publication.publication_year, first_word)))
    return keys


def candidate_pairs(publications: list[Publication]) -> set[tuple[str, str]]:
    """Publication-id pairs worth an expensive fuzzy comparison.

    Every returned pair shares at least one blocking key; two publications
    that share nothing (no identifier, no title vocabulary, no year+opening
    word) are assumed not worth comparing. This trades a small amount of
    recall on records with almost no metadata in common for avoiding an
    O(n^2) scan -- see the module-level comment above for why the chosen
    keys track _duplicate_assessment's actual match reasons.
    """
    blocks: dict[tuple[str, Any], list[str]] = defaultdict(list)
    for publication in publications:
        for key in _blocking_keys(publication):
            blocks[key].append(publication.id)
    pairs: set[tuple[str, str]] = set()
    for ids in blocks.values():
        if len(ids) < 2:
            continue
        for left_id, right_id in combinations(sorted(set(ids)), 2):
            pairs.add((left_id, right_id))
    return pairs


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


# Stages after duplicate review in which new records can still arrive (see
# sync_new_publications_with_stage) and so still need checking and merging.
DEDUP_DURING_REVIEW_STAGES = (
    ProjectStage.TITLE_ABSTRACT,
    ProjectStage.FULL_TEXT,
    ProjectStage.EXTRACTION,
    ProjectStage.COMPLETED,
)


def screening_aware_canonical(
    db: Session, left_id: str, right_id: str, preferred_id: str
) -> str | None:
    """Which record an automatic merge may keep, or None if it must not merge.

    Screening decisions stay with the record they were made on, so the record
    carrying them is always the one kept. When both carry decisions, choosing
    is a reviewer's call -- never an automatic one.
    """
    from app.screening.service import screened_publication_ids

    screened = screened_publication_ids(db, (left_id, right_id))
    if len(screened) == 2:
        return None
    if screened:
        return next(iter(screened))
    return preferred_id


def detect_duplicates(
    db: Session, project_id: str, publication_ids: list[str] | None = None
) -> int:
    """Find (and auto-merge exact) duplicates among the active publications.

    With `publication_ids`, only pairs involving those publications are
    assessed -- the incremental check for records imported after duplicate
    review. Either way, the checked records' `duplicate_check_pending` hold is
    cleared and any that are not part of an unresolved pair are released into
    screening.
    """
    focus = set(publication_ids) if publication_ids is not None else None
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
    by_id = {publication.id: publication for publication in publications}
    # Always re-assess every pair the DB already knows about, even one that
    # blocking alone would no longer regenerate: blocking must narrow which
    # *new* pairs get discovered, not silently retract a candidate (or a
    # reviewer's already-recorded "not duplicate" decision) that a previous,
    # possibly differently-blocked, run already surfaced.
    pairs_to_assess = candidate_pairs(publications) | set(existing_candidates)
    if focus is not None:
        pairs_to_assess = {
            pair for pair in pairs_to_assess if pair[0] in focus or pair[1] in focus
        }

    active_pairs: set[tuple[str, str]] = set()
    # Publications auto-merged away earlier in *this* run: any later pair
    # naming one is stale the same way a pair naming an already-inactive
    # publication is, and gets skipped/cleaned up the same way (see the
    # `left is None or right is None` branch below).
    merged_away: set[str] = set()
    created = 0
    for a_id, b_id in pairs_to_assess:
        if a_id in merged_away or b_id in merged_away:
            continue
        left = by_id.get(a_id)
        right = by_id.get(b_id)
        if left is None or right is None:
            # One side is no longer an active publication (deleted/merged
            # since the candidate was recorded); the cleanup pass below
            # removes it if it's still unresolved.
            continue
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
                # Set explicitly (matches the column default) rather than
                # relying on the ORM default, which is only applied at flush
                # -- merge_publications below checks status on this same
                # unflushed object and needs it to already read "unresolved".
                status="unresolved",
            )
            db.add(existing)
            created += 1
        existing.match_reasons = reasons
        existing.title_similarity = title_score
        existing.author_similarity = author_score
        existing.year_agreement = year_agreement
        existing.confidence = confidence

        if confidence >= AUTO_MERGE_CONFIDENCE:
            # The session is autoflush=False, and merge_publications records
            # a PublicationMerge.candidate_id -- flush now so a freshly
            # created `existing` already has its id assigned.
            db.flush()
            oldest = min(
                (left, right), key=lambda publication: (publication.created_at, publication.id)
            )
            canonical_id = screening_aware_canonical(db, left.id, right.id, oldest.id)
            if canonical_id is None:
                continue
            merge = merge_publications(db, existing, canonical_id, merged_by_id=None)
            existing.auto_resolved = True
            merged_away.add(merge.merged_publication_id)
            record_audit(
                db,
                action="duplicate.auto_merged",
                entity_type="publication_merge",
                entity_id=merge.id,
                project_id=project_id,
                summary="Automatically merged exact duplicate publications",
                metadata={
                    "canonicalPublicationId": merge.canonical_publication_id,
                    "mergedPublicationId": merge.merged_publication_id,
                    "matchReasons": reasons,
                },
            )

    for pair, candidate in existing_candidates.items():
        if focus is not None and pair not in pairs_to_assess:
            continue
        if candidate.status == "unresolved" and pair not in active_pairs:
            db.delete(candidate)
    db.flush()
    release_duplicate_check(db, project_id, publication_ids)
    return created


def release_duplicate_check(
    db: Session, project_id: str, publication_ids: list[str] | None = None
) -> None:
    """Clear the duplicate-check hold (on these publications, or every held
    one in the project) and enroll them in screening if the project is past
    duplicate review. Records still in an unresolved pair stay out until a
    reviewer resolves it."""
    from app.publications.service import sync_new_publications_with_stage

    query = select(Publication).where(
        Publication.project_id == project_id,
        Publication.duplicate_check_pending.is_(True),
    )
    if publication_ids is not None:
        query = query.where(Publication.id.in_(publication_ids))
    released = list(db.scalars(query))
    for publication in released:
        publication.duplicate_check_pending = False
    db.flush()
    project = db.get(Project, project_id)
    if released and project is not None:
        sync_new_publications_with_stage(
            db, project, [publication.id for publication in released]
        )


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
    from app.screening.service import screened_publication_ids

    screened = screened_publication_ids(db, (canonical_id, merged_id))
    if screened and canonical_id not in screened:
        raise ConflictError(
            "Keep the record that already has screening decisions: a merge "
            "does not move them to the kept record"
        )
    project = db.get(Project, candidate.project_id)
    assert project is not None
    during_review = project.stage in DEDUP_DURING_REVIEW_STAGES
    if during_review:
        from app.review_work.finalization import lock_publication_for_finalization

        for publication_id in sorted((canonical_id, merged_id)):
            lock_publication_for_finalization(db, publication_id)
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
            and values_conflict(field, canonical_value, duplicate_value)
        ):
            already = db.scalar(
                select(MetadataConflict.id).where(
                    MetadataConflict.publication_id == canonical.id,
                    MetadataConflict.field_name == field,
                    MetadataConflict.proposed_value == str(duplicate_value),
                    MetadataConflict.status == ConflictStatus.OPEN,
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
    candidate.reserved_by_id = None
    candidate.reserved_until = None
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
        stage_at_merge=project.stage.value,
        outcome_conflict_stages=(
            _reopen_disagreeing_outcomes(db, canonical.id, duplicate.id)
            if during_review and merged_id in screened
            else []
        ),
    )
    db.add(merge)
    if during_review:
        from app.publications.deletion import (
            retract_open_review_work,
            settle_stage_after_removal,
        )
        from app.publications.service import sync_new_publications_with_stage

        retract_open_review_work(db, duplicate.id)
        # The kept record may itself have been waiting on this pair.
        sync_new_publications_with_stage(db, project, [canonical.id])
        db.flush()
        settle_stage_after_removal(db, project.id)
    if conflicts_created:
        # Give an external metadata provider a chance to break the tie
        # before asking a reviewer: runs in the worker, not this request/job
        # thread, since it's a live external HTTP call.
        enqueue_job(
            db,
            "resolve_merge_conflicts",
            {"publication_id": canonical.id},
            project_id=candidate.project_id,
            created_by_id=merged_by_id,
        )
    db.flush()
    db.refresh(canonical, ["sources"])
    return merge


def _reopen_disagreeing_outcomes(
    db: Session, canonical_id: str, merged_id: str
) -> list[str]:
    """Invalidate the kept record's final decision at every screening stage
    where the merged-away record was finalized differently (or the kept one
    not at all), so a manager decides with both records' decisions in view.
    Returns those stages; automatic finalization stays off for them."""
    from app.conflicts.service import (
        invalidate_final_decisions,
        valid_final_decision,
    )
    stages: list[str] = []
    for stage in (ScreeningStage.TITLE_ABSTRACT, ScreeningStage.FULL_TEXT):
        merged_final = valid_final_decision(db, merged_id, stage)
        if merged_final is None:
            continue
        kept_final = valid_final_decision(db, canonical_id, stage)
        if kept_final is not None and kept_final.outcome == merged_final.outcome:
            continue
        invalidate_final_decisions(
            db,
            canonical_id,
            stage,
            "A merged duplicate record reached a different outcome",
        )
        stages.append(stage.value)
    return stages


def merge_outcome_conflict_stages(db: Session, publication_id: str) -> set[str]:
    """Screening stages at which an active merge into this publication left
    outcomes that disagree and need a manager's decision."""
    stages: set[str] = set()
    for flagged in db.scalars(
        select(PublicationMerge.outcome_conflict_stages).where(
            PublicationMerge.canonical_publication_id == publication_id,
            PublicationMerge.reversed_at.is_(None),
        )
    ):
        stages.update(flagged or [])
    return stages


def merged_duplicate_decisions(
    db: Session, publication_id: str, stage: ScreeningStage
) -> list[ScreeningDecision]:
    """Current screening decisions on duplicates merged into this publication
    whose outcome at `stage` disagreed with it."""
    flagged = [
        merged_id
        for merged_id, stages in db.execute(
            select(
                PublicationMerge.merged_publication_id,
                PublicationMerge.outcome_conflict_stages,
            ).where(
                PublicationMerge.canonical_publication_id == publication_id,
                PublicationMerge.reversed_at.is_(None),
            )
        )
        if stage.value in (stages or [])
    ]
    if not flagged:
        return []
    return list(
        db.scalars(
            select(ScreeningDecision)
            .join(ScreeningWorkItem)
            .options(joinedload(ScreeningDecision.reviewer))
            .where(
                ScreeningWorkItem.publication_id.in_(flagged),
                ScreeningWorkItem.stage == stage,
                ScreeningDecision.is_current.is_(True),
            )
            .order_by(ScreeningWorkItem.slot_number)
        )
    )


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
                MetadataConflict.status == ConflictStatus.OPEN,
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
    candidate.reserved_by_id = None
    candidate.reserved_until = None


# --------------------------------------------------------------------------
# Reviewer queue: reservation lease + one-at-a-time claiming
# --------------------------------------------------------------------------
#
# The duplicate-review stage is worked the same way as screening / extraction
# / quality: a reviewer is handed one unresolved candidate at a time and it is
# leased to them for a short window so a second reviewer working the queue
# concurrently is never shown the same pair. Unlike those stages there is no
# per-reviewer assignment and no separate work-item table -- the candidate row
# is the work item, and any project member may resolve any pair.


_SelectT = TypeVar("_SelectT", bound=Select[Any])


def _for_update(
    query: _SelectT, db: Session, *, skip_locked: bool = False
) -> _SelectT:
    if db.bind is not None and db.bind.dialect.name == "postgresql":
        return query.with_for_update(skip_locked=skip_locked)
    return query


def claim_next_duplicate(
    db: Session,
    project_id: str,
    reviewer_id: str,
    excluded_ids: set[str] | None = None,
) -> DuplicateCandidate | None:
    """Reserve and return the highest-confidence unresolved candidate that is
    free (unreserved, an expired lease, or already this reviewer's), or None
    when the queue is empty for this reviewer."""
    now = datetime.now(UTC)
    query = (
        select(DuplicateCandidate)
        .where(
            DuplicateCandidate.project_id == project_id,
            DuplicateCandidate.status == "unresolved",
            or_(
                DuplicateCandidate.reserved_until.is_(None),
                DuplicateCandidate.reserved_until < now,
                DuplicateCandidate.reserved_by_id == reviewer_id,
            ),
        )
        .order_by(DuplicateCandidate.confidence.desc(), DuplicateCandidate.id)
        .limit(1)
    )
    if excluded_ids:
        query = query.where(DuplicateCandidate.id.not_in(excluded_ids))
    candidate = db.scalar(_for_update(query, db, skip_locked=True))
    if candidate is not None:
        candidate.reserved_by_id = reviewer_id
        candidate.reserved_until = now + timedelta(hours=RESERVATION_HOURS)
        db.flush()
    return candidate


def release_duplicate_candidate(
    db: Session, candidate: DuplicateCandidate, reviewer_id: str
) -> None:
    """Hand a still-unresolved candidate back to the queue."""
    if candidate.reserved_by_id == reviewer_id and candidate.status == "unresolved":
        candidate.reserved_by_id = None
        candidate.reserved_until = None
        db.flush()


def lock_candidate_for_update(
    db: Session, candidate_id: str
) -> DuplicateCandidate | None:
    """Row-lock a candidate so a resolve/revise re-reads its status under the
    lock instead of racing a concurrent reviewer's decision."""
    query = select(DuplicateCandidate).where(DuplicateCandidate.id == candidate_id)
    return db.scalar(_for_update(query, db))


def duplicate_review_progress(db: Session, project_id: str) -> dict[str, int]:
    """Project-wide queue progress (duplicate review is not partitioned per
    reviewer, so this is the same for everyone)."""
    rows = db.execute(
        select(DuplicateCandidate.status, func.count())
        .where(DuplicateCandidate.project_id == project_id)
        .group_by(DuplicateCandidate.status)
    ).all()
    counts = {status: count for status, count in rows}
    remaining = counts.get("unresolved", 0)
    total = sum(counts.values())
    return {"remaining": remaining, "resolved": total - remaining, "total": total}


def revise_resolution(
    db: Session,
    project: Project,
    candidate: DuplicateCandidate,
    actor_id: str,
    resolution: str,
    canonical_id: str | None = None,
    note: str | None = None,
) -> PublicationMerge | None:
    """Change an already-resolved candidate to a different outcome.

    Revising re-shapes the post-deduplication cohort (an existing merge is
    undone and/or a new one applied) and downstream stages are built on that
    cohort, so this is confined to the duplicate-review stage exactly like a
    standalone Undo Merge -- a project that has moved on goes back through
    Move Back. Returns the new PublicationMerge when the new outcome is a
    merge, else None.
    """
    from app.projects.lifecycle import require_merge_reversal_allowed

    if resolution not in ("merge", "not_duplicate"):
        raise ConflictError("Unknown duplicate resolution")
    if candidate.status not in ("merged", "not_duplicate"):
        raise ConflictError("Only a resolved duplicate candidate can be revised")

    if candidate.status == "merged":
        active_merge = db.scalar(
            select(PublicationMerge).where(
                PublicationMerge.candidate_id == candidate.id,
                PublicationMerge.reversed_at.is_(None),
            )
        )
        if active_merge is None:
            raise NotFoundError("No active merge to revise for this candidate")
        require_merge_reversal_allowed(db, project, active_merge)
        # reverse_merge resets the candidate back to "unresolved".
        reverse_merge(db, active_merge, actor_id)
    else:
        require_merge_reversal_allowed(db, project)

    if candidate.status != "unresolved":
        # Was "not_duplicate": merge_publications' guard needs "unresolved".
        candidate.status = "unresolved"
        candidate.resolved_by_id = None
        candidate.resolution_note = None

    new_merge: PublicationMerge | None = None
    if resolution == "merge":
        if canonical_id not in (
            candidate.publication_a_id,
            candidate.publication_b_id,
        ):
            raise ConflictError(
                "Canonical publication must belong to the candidate pair"
            )
        new_merge = merge_publications(db, candidate, canonical_id, actor_id)
    else:
        mark_not_duplicate(candidate, actor_id, note)
        release_resolved_pair(db, project, candidate)

    transition_if_duplicate_review_complete(db, project)
    return new_merge


def release_resolved_pair(
    db: Session, project: Project, candidate: DuplicateCandidate
) -> None:
    """Enroll a pair judged distinct in screening, if the project is past
    duplicate review and they were waiting on this decision (records already
    enrolled are left as they are)."""
    from app.publications.service import sync_new_publications_with_stage

    db.flush()
    sync_new_publications_with_stage(
        db, project, [candidate.publication_a_id, candidate.publication_b_id]
    )


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
    from app.projects.lifecycle import set_project_stage
    from app.projects.models import ScreeningStage
    from app.screening.service import create_screening_work_items

    set_project_stage(
        project, ProjectStage.TITLE_ABSTRACT, reason="duplicate review complete"
    )

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
