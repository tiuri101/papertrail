from __future__ import annotations

from collections import Counter
from xml.sax.saxutils import escape as xml_escape

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.conflicts.models import FinalDecision
from app.deduplication.models import PublicationMerge
from app.fulltext.models import FullTextRetrieval, RetrievalStatus
from app.imports.models import ImportBatch, ImportedRecord
from app.projects.models import ScreeningStage
from app.publications.models import Publication, PublicationSource
from app.screening.models import ScreeningDecision, ScreeningOutcome, ScreeningWorkItem


def calculate_prisma_counts(
    db: Session,
    project_id: str,
) -> dict[str, int | dict[str, int]]:
    database_records = (
        db.scalar(
            select(func.count())
            .select_from(ImportedRecord)
            .join(ImportBatch)
            .where(
                ImportBatch.project_id == project_id,
                ImportBatch.search_source_id.is_not(None),
            )
        )
        or 0
    )
    imported_publication_ids = (
        select(PublicationSource.publication_id)
        .join(ImportedRecord)
        .join(ImportBatch)
        .where(ImportBatch.project_id == project_id)
    )
    other_records = (
        db.scalar(
            select(func.count())
            .select_from(Publication)
            .where(
                Publication.project_id == project_id,
                ~Publication.id.in_(imported_publication_ids),
            )
        )
        or 0
    )
    duplicates_removed = (
        db.scalar(
            select(func.count())
            .select_from(PublicationMerge)
            .where(
                PublicationMerge.project_id == project_id,
                PublicationMerge.reversed_at.is_(None),
            )
        )
        or 0
    )
    title_finals = list(
        db.scalars(
            select(FinalDecision).where(
                FinalDecision.project_id == project_id,
                FinalDecision.stage == ScreeningStage.TITLE_ABSTRACT,
                FinalDecision.is_valid.is_(True),
            )
        )
    )
    full_finals = list(
        db.scalars(
            select(FinalDecision).where(
                FinalDecision.project_id == project_id,
                FinalDecision.stage == ScreeningStage.FULL_TEXT,
                FinalDecision.is_valid.is_(True),
            )
        )
    )
    retrievals = list(
        db.scalars(
            select(FullTextRetrieval).where(FullTextRetrieval.project_id == project_id)
        )
    )
    reasons = _full_text_exclusion_reasons(db, full_finals)
    return {
        "recordsIdentifiedDatabases": int(database_records),
        "recordsIdentifiedOtherSources": int(other_records),
        "duplicatesRemoved": int(duplicates_removed),
        "recordsScreened": len(title_finals),
        "recordsExcluded": sum(
            item.outcome == ScreeningOutcome.EXCLUDE for item in title_finals
        ),
        "reportsSought": sum(
            item.outcome == ScreeningOutcome.INCLUDE for item in title_finals
        ),
        "reportsNotRetrieved": sum(
            item.status in {RetrievalStatus.NOT_FOUND, RetrievalStatus.INACCESSIBLE}
            for item in retrievals
        ),
        "reportsAssessed": len(full_finals),
        "fullTextExclusions": dict(reasons),
        "includedPublications": sum(
            item.outcome == ScreeningOutcome.INCLUDE for item in full_finals
        ),
    }


def _full_text_exclusion_reasons(
    db: Session,
    final_decisions: list[FinalDecision],
) -> Counter[str]:
    reasons: Counter[str] = Counter()
    excluded_ids = {
        item.publication_id
        for item in final_decisions
        if item.outcome == ScreeningOutcome.EXCLUDE
    }
    for publication_id in excluded_ids:
        decision = db.scalar(
            select(ScreeningDecision)
            .join(ScreeningWorkItem)
            .where(
                ScreeningWorkItem.publication_id == publication_id,
                ScreeningWorkItem.stage == ScreeningStage.FULL_TEXT,
                ScreeningDecision.is_current.is_(True),
                ScreeningDecision.outcome == ScreeningOutcome.EXCLUDE,
            )
            .order_by(ScreeningDecision.created_at)
        )
        label = (
            decision.exclusion_reason_text
            if decision and decision.exclusion_reason_text
            else "Other"
        )
        reasons[label] += 1
    return reasons


def build_prisma_svg(project_name: str, counts: dict) -> str:
    rows = [
        (
            "Records identified",
            counts["recordsIdentifiedDatabases"]
            + counts["recordsIdentifiedOtherSources"],
        ),
        ("Duplicates removed", counts["duplicatesRemoved"]),
        ("Records screened", counts["recordsScreened"]),
        ("Records excluded", counts["recordsExcluded"]),
        ("Reports sought for retrieval", counts["reportsSought"]),
        ("Reports not retrieved", counts["reportsNotRetrieved"]),
        ("Reports assessed for eligibility", counts["reportsAssessed"]),
        ("Publications included", counts["includedPublications"]),
    ]
    height = 90 + len(rows) * 82
    boxes: list[str] = []
    for index, (label, value) in enumerate(rows):
        y = 60 + index * 82
        boxes.extend(
            [
                f'<rect x="40" y="{y}" width="520" height="54" rx="8" '
                'fill="white" stroke="#334155"/>',
                f'<text x="58" y="{y + 24}" font-family="sans-serif" '
                f'font-size="15">{xml_escape(label)}</text>',
                f'<text x="530" y="{y + 34}" text-anchor="end" '
                f'font-family="sans-serif" font-size="22" font-weight="bold">'
                f"{value}</text>",
            ]
        )
        if index < len(rows) - 1:
            boxes.append(
                f'<line x1="300" y1="{y + 54}" x2="300" y2="{y + 82}" '
                'stroke="#334155" marker-end="url(#arrow)"/>'
            )
    title = xml_escape(project_name)
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="600" height="{height}" '
        f'viewBox="0 0 600 {height}" role="img" '
        f'aria-label="PRISMA 2020 flow diagram for {title}">'
        '<defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="4" '
        'refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#334155"/>'
        '</marker></defs><rect width="100%" height="100%" fill="#f8fafc"/>'
        f'<text x="300" y="32" text-anchor="middle" font-family="sans-serif" '
        f'font-size="18" font-weight="bold">{title} — PRISMA 2020</text>'
        f'{"".join(boxes)}</svg>'
    )
