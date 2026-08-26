"""Concurrent-finalization regression tests, against a real PostgreSQL server.

These are the only tests in the suite that cannot run on the default in-memory
SQLite engine: what they exercise is two *separate database transactions*
racing to finalize the same publication, and the defence is PostgreSQL row
locking (``app.review_work.finalization``). SQLite has no row-level locking
and serializes writers at the database level, so it cannot reproduce the bug
or prove the fix.

Each test drives two real threads with real sessions on their own
connections. The interleaving is forced deterministically rather than hoped
for: the first transaction submits its slot and performs its "is the stage
complete?" read, then holds without committing while the second transaction
starts. Against the unfixed code both transactions see only their own
submission, neither finalizes, and the publication is left with every
required slot submitted and no authoritative outcome. Against the fixed code
the second transaction blocks on the publication row until the first commits,
then reads both submissions and finalizes exactly once.

The scratch database is created and dropped by this module: it never touches
an existing database. Point PAPERTRAIL_CONCURRENCY_TEST_DATABASE_URL (or
PAPERTRAIL_TEST_DATABASE_URL, if it is a PostgreSQL URL) at any server the
test user may create databases on; the default is the local dev container from
docker-compose.dev.yml. If no server is reachable the module skips -- it never
silently degrades into a mock.
"""

from __future__ import annotations

import os
import secrets
import threading
import time
from collections.abc import Callable
from typing import Any

import pytest
import sqlalchemy
from sqlalchemy import create_engine, select, text
from sqlalchemy.engine import Engine, make_url
from sqlalchemy.orm import Session, sessionmaker

from app.accounts.service import create_user
from app.audit.models import AuditEvent
from app.conflicts.models import FinalDecision
from app.conflicts.service import (
    conflicted_publication_ids,
    record_final_decision,
    refresh_automatic_final_decision,
)
from app.db.base import Base
from app.extraction.models import (
    ExtractionConfig,
    ExtractionStatus,
    ExtractionWorkItem,
    FinalExtraction,
)
from app.extraction.reconciliation import reconciliation_queue
from app.extraction.service import initialize_extraction, submit_extraction
from app.forms.models import FormKind
from app.forms.service import add_field, create_form
from app.projects.models import (
    AllocationMode,
    Criterion,
    CriterionKind,
    Project,
    ProjectMembership,
    ProjectStage,
    ResolutionMethod,
    ReviewType,
    ScreeningConfig,
    ScreeningStage,
    TaskAllocationMode,
)
from app.publications.models import Publication
from app.screening.models import ScreeningDecision, ScreeningOutcome, ScreeningWorkItem
from app.screening.service import create_screening_work_items, submit_decision

DEFAULT_ADMIN_URL = "postgresql+psycopg://papertrail:papertrail-dev@127.0.0.1:5432/papertrail"

# A wedged lock must fail the test, not hang the suite: 20s is far longer than
# any legitimate wait here (the other transaction commits within milliseconds
# of being released) and short enough to fail fast if the lock is ever taken
# in an order that cannot resolve.
LOCK_TIMEOUT = "20s"
THREAD_TIMEOUT = 60.0


def _admin_url() -> str:
    configured = os.getenv("PAPERTRAIL_CONCURRENCY_TEST_DATABASE_URL")
    if configured:
        return configured
    fallback = os.getenv("PAPERTRAIL_TEST_DATABASE_URL", "")
    if fallback.startswith("postgresql"):
        return fallback
    return DEFAULT_ADMIN_URL


@pytest.fixture(scope="module")
def pg_engine() -> Any:
    """A throwaway PostgreSQL database, created and dropped by this module."""
    admin_url = make_url(_admin_url())
    scratch_name = f"papertrail_concurrency_{secrets.token_hex(6)}"
    try:
        admin_engine = create_engine(admin_url, isolation_level="AUTOCOMMIT")
        with admin_engine.connect() as connection:
            connection.execute(text(f'CREATE DATABASE "{scratch_name}"'))
    except sqlalchemy.exc.SQLAlchemyError as exc:  # pragma: no cover - env dependent
        pytest.skip(
            "concurrent-finalization tests need a reachable PostgreSQL server "
            f"({admin_url.render_as_string(hide_password=True)}): {exc}"
        )

    engine: Engine = create_engine(admin_url.set(database=scratch_name))
    try:
        Base.metadata.create_all(engine)
        yield engine
    finally:
        engine.dispose()
        with admin_engine.connect() as connection:
            connection.execute(
                text(f'DROP DATABASE IF EXISTS "{scratch_name}" WITH (FORCE)')
            )
        admin_engine.dispose()


@pytest.fixture()
def pg_sessions(pg_engine: Engine) -> Any:
    """A session factory over the scratch database, wiped between tests."""
    factory = sessionmaker(bind=pg_engine, autoflush=False, expire_on_commit=False)
    yield factory
    with pg_engine.begin() as connection:
        for table in reversed(Base.metadata.sorted_tables):
            connection.execute(text(f'TRUNCATE TABLE "{table.name}" CASCADE'))


def _open(factory: Any) -> Session:
    session = factory()
    session.execute(text(f"SET lock_timeout = '{LOCK_TIMEOUT}'"))
    return session


def _run_racing_pair(
    first: Callable[[threading.Event, threading.Event], None],
    second: Callable[[threading.Event, threading.Event], None],
) -> None:
    """Run two transactions with a forced interleaving.

    ``first`` signals ``read_done`` once it has written its slot and read the
    stage back but has *not* committed; ``second`` then starts and signals
    ``second_started`` immediately before the call that must contend for the
    publication. Whichever mechanism serializes them, both threads must finish
    and neither may raise.
    """
    read_done = threading.Event()
    second_started = threading.Event()
    failures: list[BaseException] = []

    def guard(target: Callable[[threading.Event, threading.Event], None]) -> Callable[[], None]:
        def run() -> None:
            try:
                target(read_done, second_started)
            except BaseException as exc:  # noqa: BLE001 - reported below
                failures.append(exc)
                read_done.set()
                second_started.set()

        return run

    threads = [
        threading.Thread(target=guard(first), name="first"),
        threading.Thread(target=guard(second), name="second"),
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(THREAD_TIMEOUT)
    alive = [thread.name for thread in threads if thread.is_alive()]
    assert not alive, f"transactions did not finish (deadlock?): {alive}"
    if failures:
        raise failures[0]


# ---------------------------------------------------------------------------
# Screening: two reviewers submit the last two slots at the same time
# ---------------------------------------------------------------------------


def _setup_screening(
    factory: Any,
    *,
    required_reviewers: int = 2,
    conflict_resolution: ResolutionMethod = ResolutionMethod.ADMIN_CONSENSUS,
) -> tuple[str, str, list[str], list[str]]:
    db = factory()
    try:
        reviewers = [
            create_user(db, f"reviewer{n}", f"Reviewer {n}", f"long-password-{n}")
            for n in range(1, required_reviewers + 1)
        ]
        project = Project(
            name="Concurrent screening",
            review_type=ReviewType.SYSTEMATIC_REVIEW,
            random_seed="seed",
            stage=ProjectStage.TITLE_ABSTRACT,
        )
        db.add(project)
        db.flush()
        for reviewer in reviewers:
            db.add(
                ProjectMembership(
                    project_id=project.id,
                    user_id=reviewer.id,
                    can_title_abstract_screen=True,
                )
            )
        db.add(
            ScreeningConfig(
                project_id=project.id,
                stage=ScreeningStage.TITLE_ABSTRACT,
                required_reviewers=required_reviewers,
                allocation_mode=AllocationMode.INDEPENDENT,
                conflict_resolution=conflict_resolution,
                uncertain_resolution=ResolutionMethod.ADMIN_CONSENSUS,
            )
        )
        criterion = Criterion(
            project_id=project.id,
            kind=CriterionKind.INCLUSION,
            text="Relevant topic",
            position=0,
        )
        publication = Publication(project_id=project.id, title="Paper", abstract="A")
        db.add_all([criterion, publication])
        db.commit()
        created = create_screening_work_items(db, project, ScreeningStage.TITLE_ABSTRACT)
        assert created == required_reviewers
        db.commit()
        items = list(
            db.scalars(
                select(ScreeningWorkItem)
                .where(ScreeningWorkItem.publication_id == publication.id)
                .order_by(ScreeningWorkItem.slot_number)
            )
        )
        assigned = [item.assigned_reviewer_id for item in items]
        assert None not in assigned and len(set(assigned)) == required_reviewers
        return (
            project.id,
            publication.id,
            [item.id for item in items],
            [criterion.id],
        )
    finally:
        db.close()


def _screening_racers(
    factory: Any,
    item_ids: list[str],
    criterion_ids: list[str],
    outcomes: tuple[str, str],
) -> tuple[Callable[..., None], Callable[..., None]]:
    answers = {criterion_id: True for criterion_id in criterion_ids}

    def submit(item_id: str, outcome: str) -> Session:
        db = _open(factory)
        item = db.get(ScreeningWorkItem, item_id)
        assert item is not None
        assert item.assigned_reviewer_id is not None
        submit_decision(db, item, item.assigned_reviewer_id, outcome, answers, None)
        refresh_automatic_final_decision(db, item.publication_id, item.stage)
        return db

    def first(read_done: threading.Event, second_started: threading.Event) -> None:
        db = submit(item_ids[0], outcomes[0])
        try:
            read_done.set()
            second_started.wait(THREAD_TIMEOUT)
            # Give the second transaction time to actually reach the contended
            # row before releasing it, so the interleaving is the one intended
            # rather than an accidental sequential run.
            time.sleep(0.5)
            db.commit()
        finally:
            db.close()

    def second(read_done: threading.Event, second_started: threading.Event) -> None:
        read_done.wait(THREAD_TIMEOUT)
        second_started.set()
        db = submit(item_ids[1], outcomes[1])
        try:
            db.commit()
        finally:
            db.close()

    return first, second


def _valid_finals(db: Session, publication_id: str) -> list[FinalDecision]:
    return list(
        db.scalars(
            select(FinalDecision).where(
                FinalDecision.publication_id == publication_id,
                FinalDecision.stage == ScreeningStage.TITLE_ABSTRACT,
                FinalDecision.is_valid.is_(True),
            )
        )
    )


def test_concurrent_agreeing_submissions_produce_exactly_one_final_decision(
    pg_sessions,
) -> None:
    _project_id, publication_id, item_ids, criterion_ids = _setup_screening(pg_sessions)

    first, second = _screening_racers(
        pg_sessions, item_ids, criterion_ids, ("include", "include")
    )
    _run_racing_pair(first, second)

    db = pg_sessions()
    try:
        decisions = list(
            db.scalars(
                select(ScreeningDecision)
                .join(ScreeningWorkItem)
                .where(
                    ScreeningWorkItem.publication_id == publication_id,
                    ScreeningDecision.is_current.is_(True),
                )
            )
        )
        assert len(decisions) == 2, "both reviewers' decisions must be recorded"

        finals = _valid_finals(db, publication_id)
        assert len(finals) == 1, (
            "quorum was reached, so exactly one authoritative final decision "
            f"must exist, found {len(finals)}"
        )
        assert finals[0].outcome == ScreeningOutcome.INCLUDE
        assert finals[0].resolution_method == "agreement"
    finally:
        db.close()


def test_concurrent_disagreeing_submissions_leave_a_resolvable_conflict(
    pg_sessions,
) -> None:
    project_id, publication_id, item_ids, criterion_ids = _setup_screening(pg_sessions)

    first, second = _screening_racers(
        pg_sessions, item_ids, criterion_ids, ("include", "exclude")
    )
    _run_racing_pair(first, second)

    db = pg_sessions()
    try:
        # Disagreement under admin_consensus has no automatic verdict, so the
        # invariant here is the mirror image: no final decision is invented,
        # and the publication is reliably visible as a conflict to resolve --
        # never silently lost between the two transactions.
        assert _valid_finals(db, publication_id) == []
        assert conflicted_publication_ids(db, project_id, ScreeningStage.TITLE_ABSTRACT) == [
            publication_id
        ]
        db.rollback()
    finally:
        db.close()


def test_concurrent_submissions_completing_a_majority_finalize_once(
    pg_sessions,
) -> None:
    """Disagreement that still resolves automatically -- the case where a lost
    finalization actually costs a verdict rather than a conflict entry."""
    _project_id, publication_id, item_ids, criterion_ids = _setup_screening(
        pg_sessions,
        required_reviewers=3,
        conflict_resolution=ResolutionMethod.MAJORITY,
    )
    answers = {criterion_id: True for criterion_id in criterion_ids}

    # The first reviewer decides on their own, well before the others; quorum
    # is still one short, so nothing is final yet.
    db = pg_sessions()
    try:
        item = db.get(ScreeningWorkItem, item_ids[0])
        assert item is not None and item.assigned_reviewer_id is not None
        submit_decision(db, item, item.assigned_reviewer_id, "include", answers, None)
        refresh_automatic_final_decision(db, publication_id, ScreeningStage.TITLE_ABSTRACT)
        db.commit()
        assert _valid_finals(db, publication_id) == []
    finally:
        db.close()

    # The remaining two race. Their outcomes differ, so only a transaction that
    # sees all three decisions can resolve the 2-1 majority.
    first, second = _screening_racers(
        pg_sessions, item_ids[1:], criterion_ids, ("include", "exclude")
    )
    _run_racing_pair(first, second)

    db = pg_sessions()
    try:
        finals = _valid_finals(db, publication_id)
        assert len(finals) == 1, (
            "a 2-1 majority was reached, so exactly one authoritative final "
            f"decision must exist, found {len(finals)}"
        )
        assert finals[0].outcome == ScreeningOutcome.INCLUDE
        assert finals[0].resolution_method == "majority"
    finally:
        db.close()


# ---------------------------------------------------------------------------
# Extraction: two extractors complete the two slots at the same time
# ---------------------------------------------------------------------------


def _setup_extraction(factory: Any) -> tuple[str, str, list[str], str]:
    db = factory()
    try:
        reviewers = [
            create_user(db, "extractor1", "Extractor 1", "long-password-1"),
            create_user(db, "extractor2", "Extractor 2", "long-password-2"),
        ]
        project = Project(
            name="Concurrent extraction",
            review_type=ReviewType.SYSTEMATIC_REVIEW,
            random_seed="seed",
            stage=ProjectStage.FULL_TEXT,
        )
        db.add(project)
        db.flush()
        for reviewer in reviewers:
            db.add(
                ProjectMembership(
                    project_id=project.id, user_id=reviewer.id, can_extract=True
                )
            )
        db.add(
            ExtractionConfig(
                project_id=project.id,
                required_reviewers=2,
                allocation_mode=TaskAllocationMode.PRE_ASSIGNED,
            )
        )
        form = create_form(db, "Extraction", FormKind.EXTRACTION, project_id=project.id)
        field = add_field(db, form, "Summary", "long_text", required=True)
        publication = Publication(project_id=project.id, title="Paper")
        db.add(publication)
        db.flush()
        record_final_decision(
            db,
            publication.id,
            ScreeningStage.FULL_TEXT,
            "include",
            "agreement",
            None,
            None,
        )
        project.stage = ProjectStage.EXTRACTION
        db.commit()
        initialize_extraction(db, project)
        db.commit()
        items = list(
            db.scalars(
                select(ExtractionWorkItem)
                .where(ExtractionWorkItem.publication_id == publication.id)
                .order_by(ExtractionWorkItem.slot_number)
            )
        )
        assert len(items) == 2
        assigned = [item.assigned_reviewer_id for item in items]
        assert None not in assigned and len(set(assigned)) == 2
        return project.id, publication.id, [item.id for item in items], field.stable_key
    finally:
        db.close()


def _extraction_racers(
    factory: Any, item_ids: list[str], stable_key: str, answers: tuple[str, str]
) -> tuple[Callable[..., None], Callable[..., None]]:
    def submit(item_id: str, value: str) -> Session:
        db = _open(factory)
        item = db.get(ExtractionWorkItem, item_id)
        assert item is not None
        assert item.assigned_reviewer_id is not None
        submit_extraction(db, item, item.assigned_reviewer_id, {stable_key: value})
        return db

    def first(read_done: threading.Event, second_started: threading.Event) -> None:
        db = submit(item_ids[0], answers[0])
        try:
            read_done.set()
            second_started.wait(THREAD_TIMEOUT)
            time.sleep(0.5)
            db.commit()
        finally:
            db.close()

    def second(read_done: threading.Event, second_started: threading.Event) -> None:
        read_done.wait(THREAD_TIMEOUT)
        second_started.set()
        db = submit(item_ids[1], answers[1])
        try:
            db.commit()
        finally:
            db.close()

    return first, second


def test_concurrent_agreeing_extractions_produce_exactly_one_final_extraction(
    pg_sessions,
) -> None:
    _project_id, publication_id, item_ids, stable_key = _setup_extraction(pg_sessions)

    first, second = _extraction_racers(
        pg_sessions, item_ids, stable_key, ("Same finding", "Same finding")
    )
    _run_racing_pair(first, second)

    db = pg_sessions()
    try:
        completed = list(
            db.scalars(
                select(ExtractionWorkItem).where(
                    ExtractionWorkItem.publication_id == publication_id,
                    ExtractionWorkItem.status == ExtractionStatus.COMPLETED,
                )
            )
        )
        assert len(completed) == 2, "both slots must be recorded as completed"

        finals = list(
            db.scalars(
                select(FinalExtraction).where(
                    FinalExtraction.publication_id == publication_id,
                    FinalExtraction.is_valid.is_(True),
                )
            )
        )
        assert len(finals) == 1, (
            "both slots completed and agreed, so exactly one authoritative "
            f"final extraction must exist, found {len(finals)}"
        )
        assert finals[0].resolution_method == "agreement"
        assert finals[0].answers[stable_key] == "Same finding"
    finally:
        db.close()


def test_concurrent_disagreeing_extractions_record_reconciliation_required(
    pg_sessions,
) -> None:
    project_id, publication_id, item_ids, stable_key = _setup_extraction(pg_sessions)

    first, second = _extraction_racers(
        pg_sessions, item_ids, stable_key, ("One reading", "A different reading")
    )
    _run_racing_pair(first, second)

    db = pg_sessions()
    try:
        assert (
            db.scalar(
                select(FinalExtraction.id).where(
                    FinalExtraction.publication_id == publication_id,
                    FinalExtraction.is_valid.is_(True),
                )
            )
            is None
        ), "disagreeing slots must not be auto-finalized"
        queued = [publication.id for publication in reconciliation_queue(db, project_id)]
        assert queued == [publication_id]
        # The derived queue alone would recover from a lost finalization by
        # accident; the audit event is only written by whichever transaction
        # actually observed both completed slots, so it is the direct evidence
        # that one of them did.
        assert (
            db.scalar(
                select(AuditEvent.id).where(
                    AuditEvent.action == "extraction.reconciliation_required",
                    AuditEvent.entity_id == publication_id,
                )
            )
            is not None
        )
    finally:
        db.close()
