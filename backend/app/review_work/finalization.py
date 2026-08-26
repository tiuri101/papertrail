"""Serializing the per-publication finalization of a review stage.

Screening quorum finalization (``app.conflicts.service``) and dual-extraction
auto-finalization (``app.extraction.reconciliation``) share one shape: each
reviewer slot is submitted in its own request and its own transaction, and
whoever commits last has to be the one that sees every sibling slot and
derives the authoritative result from them.

Without serialization, two reviewers submitting at the same time can each
read only their own submission, each conclude the stage is still waiting on
the other, and both commit -- leaving every required slot submitted and no
authoritative row at all.  For screening that is a publication with two
decisions and no ``FinalDecision``; for extraction, both slots completed and
neither a ``FinalExtraction`` nor the reconciliation-required audit trail.

The publication row is the serialization point.  Taking ``SELECT ... FOR
UPDATE`` on it *before* reading the sibling slots forces the second
transaction to wait for the first to commit and -- under PostgreSQL's default
READ COMMITTED isolation, where every statement takes a fresh snapshot -- to
see that committed submission when it finally reads.  Exactly one of the two
therefore observes a complete set of slots and finalizes.

Locking the publication rather than the project keeps the serialized region
exactly as wide as the invariant it protects: reviewers working on different
publications never block each other.  The lock is held until the transaction
commits, which is what makes the read-then-finalize sequence atomic; callers
must not commit between acquiring it and finalizing.

Lock ordering: the publication is the middle of the project-wide convention
Project -> Publication -> work item / final rows.  Code that needs the
project row as well must take it first.

SQLite (the default test backend) has no row-level locking and serializes
writers at the database level anyway, so this is a documented no-op there;
the concurrency regression tests that depend on it run against PostgreSQL.
"""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.publications.models import Publication


def lock_publication_for_finalization(db: Session, publication_id: str) -> None:
    """Serialize this transaction's stage finalization for one publication.

    Idempotent within a transaction: re-taking a lock the transaction already
    holds is free, so every entry point into a finalization path can call it
    without the callers having to know which of them got there first.
    """
    if db.bind is None or db.bind.dialect.name != "postgresql":
        return
    db.execute(
        select(Publication.id)
        .where(Publication.id == publication_id)
        .with_for_update()
    ).first()
