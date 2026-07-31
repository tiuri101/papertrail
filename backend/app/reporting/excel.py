from __future__ import annotations

import json
from datetime import UTC, datetime
from io import BytesIO

from openpyxl import Workbook
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.audit.models import AuditEvent
from app.conflicts.models import FinalDecision
from app.deduplication.models import DuplicateCandidate
from app.extraction.models import ExtractionResponse, ExtractionWorkItem
from app.fulltext.models import FullTextRetrieval
from app.imports.models import ImportBatch, SearchSource
from app.projects.models import (
    Criterion,
    CriterionKind,
    Project,
    ResearchQuestion,
    ScreeningStage,
)
from app.publications.models import Publication
from app.quality.models import QualityResponse, QualityWorkItem
from app.reporting.prisma import calculate_prisma_counts
from app.screening.models import ScreeningDecision, ScreeningOutcome, ScreeningWorkItem


def safe_cell(value):
    if isinstance(value, datetime) and value.utcoffset() is not None:
        return value.astimezone(UTC).replace(tzinfo=None)

    if isinstance(value, str) and value.startswith(("=", "+", "-", "@")):
        return "'" + value

    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False)

    return value


def add_sheet(
    workbook: Workbook,
    title: str,
    headers: list[str],
    rows: list[list],
) -> None:
    sheet = workbook.create_sheet(title)
    sheet.append(headers)
    for row in rows:
        sheet.append([safe_cell(value) for value in row])
    sheet.freeze_panes = "A2"
    sheet.auto_filter.ref = sheet.dimensions
    for column in sheet.columns:
        maximum = max(
            (len(str(cell.value)) if cell.value is not None else 0) for cell in column
        )
        sheet.column_dimensions[column[0].column_letter].width = max(
            10,
            min(60, maximum + 2),
        )


def publication_rows(publications: list[Publication]) -> list[list]:
    return [
        [
            publication.id,
            publication.title,
            publication.authors,
            publication.publication_year,
            publication.venue,
            publication.publication_type,
            publication.doi,
            publication.publisher_url,
            publication.keywords,
            publication.is_active,
            publication.merged_into_id,
        ]
        for publication in publications
    ]


def _screening_rows(
    decisions: list[ScreeningDecision],
    stage: ScreeningStage,
) -> list[list]:
    return [
        [
            decision.work_item.publication_id,
            decision.reviewer_id,
            decision.outcome.value,
            decision.criteria_answers,
            decision.notes,
            decision.version,
        ]
        for decision in decisions
        if decision.work_item.stage == stage
    ]


def build_excel(db: Session, project_id: str) -> bytes:
    project = db.get(Project, project_id)
    if project is None:
        raise ValueError("Project not found")
    workbook = Workbook()
    workbook.remove(workbook.active)
    counts = calculate_prisma_counts(db, project_id)
    add_sheet(
        workbook,
        "Project overview",
        ["Field", "Value"],
        [
            ["Project ID", project.id],
            ["Name", project.name],
            ["Review type", project.review_type.value],
            ["Stage", project.stage.value],
            *[[key, value] for key, value in counts.items()],
        ],
    )
    _add_configuration_sheets(db, workbook, project_id)
    publications = _add_record_sheets(db, workbook, project_id)
    included_ids = _add_screening_sheets(db, workbook, project_id)
    publication_headers = [
        "ID",
        "Title",
        "Authors",
        "Year",
        "Venue",
        "Type",
        "DOI",
        "Publisher URL",
        "Keywords",
        "Active",
        "Merged into",
    ]
    add_sheet(
        workbook,
        "Included publications",
        publication_headers,
        publication_rows(
            [
                publication
                for publication in publications
                if publication.id in included_ids
            ]
        ),
    )
    _add_evidence_sheets(db, workbook, project_id)
    _add_audit_sheet(db, workbook, project_id)
    buffer = BytesIO()
    workbook.save(buffer)
    return buffer.getvalue()


def _add_configuration_sheets(db: Session, workbook: Workbook, project_id: str) -> None:
    research_questions = list(
        db.scalars(
            select(ResearchQuestion)
            .where(ResearchQuestion.project_id == project_id)
            .order_by(ResearchQuestion.position)
        )
    )
    add_sheet(
        workbook,
        "Research questions",
        ["ID", "Position", "Question"],
        [[item.id, item.position, item.text] for item in research_questions],
    )
    criteria = list(
        db.scalars(
            select(Criterion)
            .where(Criterion.project_id == project_id)
            .order_by(Criterion.position)
        )
    )
    for kind, title in (
        (CriterionKind.INCLUSION, "Inclusion criteria"),
        (CriterionKind.EXCLUSION, "Exclusion criteria"),
    ):
        add_sheet(
            workbook,
            title,
            ["ID", "Position", "Criterion"],
            [
                [item.id, item.position, item.text]
                for item in criteria
                if item.kind == kind
            ],
        )
    searches = list(
        db.scalars(select(SearchSource).where(SearchSource.project_id == project_id))
    )
    add_sheet(
        workbook,
        "Search documentation",
        ["ID", "Source", "Query", "Search date", "Filters", "Exported count"],
        [
            [
                item.id,
                item.source_name,
                item.query,
                item.search_date,
                item.filters,
                item.exported_result_count,
            ]
            for item in searches
        ],
    )

def _add_record_sheets(
    db: Session,
    workbook: Workbook,
    project_id: str,
) -> list[Publication]:
    batches = list(
        db.scalars(select(ImportBatch).where(ImportBatch.project_id == project_id))
    )
    add_sheet(
        workbook,
        "Imports",
        ["ID", "Filename", "Type", "Status", "Records", "Invalid"],
        [
            [
                item.id,
                item.original_filename,
                item.file_type,
                item.status.value,
                item.record_count,
                item.invalid_record_count,
            ]
            for item in batches
        ],
    )
    publications = list(
        db.scalars(
            select(Publication)
            .where(Publication.project_id == project_id)
            .order_by(Publication.title)
        )
    )
    headers = [
        "ID",
        "Title",
        "Authors",
        "Year",
        "Venue",
        "Type",
        "DOI",
        "Publisher URL",
        "Keywords",
        "Active",
        "Merged into",
    ]
    add_sheet(workbook, "Normalized records", headers, publication_rows(publications))
    candidates = list(
        db.scalars(
            select(DuplicateCandidate).where(
                DuplicateCandidate.project_id == project_id
            )
        )
    )
    add_sheet(
        workbook,
        "Duplicate decisions",
        ["ID", "Publication A", "Publication B", "Reasons", "Confidence", "Status"],
        [
            [
                item.id,
                item.publication_a_id,
                item.publication_b_id,
                item.match_reasons,
                item.confidence,
                item.status,
            ]
            for item in candidates
        ],
    )
    return publications


def _add_screening_sheets(db: Session, workbook: Workbook, project_id: str) -> set[str]:
    decisions = list(
        db.scalars(
            select(ScreeningDecision)
            .join(ScreeningWorkItem)
            .where(
                ScreeningWorkItem.project_id == project_id,
                ScreeningDecision.is_current.is_(True),
            )
        )
    )
    headers = [
        "Publication ID",
        "Reviewer ID",
        "Outcome",
        "Criteria",
        "Notes",
        "Version",
    ]
    add_sheet(
        workbook,
        "Title abstract screening",
        headers,
        _screening_rows(decisions, ScreeningStage.TITLE_ABSTRACT),
    )
    retrievals = list(
        db.scalars(
            select(FullTextRetrieval).where(FullTextRetrieval.project_id == project_id)
        )
    )
    add_sheet(
        workbook,
        "Full text retrieval",
        ["Publication ID", "Status", "Note"],
        [[item.publication_id, item.status.value, item.note] for item in retrievals],
    )
    add_sheet(
        workbook,
        "Full text screening",
        headers,
        _screening_rows(decisions, ScreeningStage.FULL_TEXT),
    )
    finals = list(
        db.scalars(
            select(FinalDecision).where(
                FinalDecision.project_id == project_id,
                FinalDecision.is_valid.is_(True),
            )
        )
    )
    add_sheet(
        workbook,
        "Exclusions",
        ["Publication ID", "Stage", "Outcome", "Resolution", "Note"],
        [
            [
                item.publication_id,
                item.stage.value,
                item.outcome.value,
                item.resolution_method,
                item.note,
            ]
            for item in finals
            if item.outcome == ScreeningOutcome.EXCLUDE
        ],
    )
    return {
        item.publication_id
        for item in finals
        if item.stage == ScreeningStage.FULL_TEXT
        and item.outcome == ScreeningOutcome.INCLUDE
    }


def _add_evidence_sheets(db: Session, workbook: Workbook, project_id: str) -> None:
    extraction = list(
        db.scalars(
            select(ExtractionResponse)
            .join(ExtractionWorkItem)
            .where(
                ExtractionWorkItem.project_id == project_id,
                ExtractionResponse.is_current.is_(True),
            )
        )
    )
    add_sheet(
        workbook,
        "Extraction",
        ["Publication ID", "Reviewer ID", "Form version", "Answers"],
        [
            [
                item.work_item.publication_id,
                item.reviewer_id,
                item.form_version_id,
                item.answers,
            ]
            for item in extraction
        ],
    )
    quality = list(
        db.scalars(
            select(QualityResponse)
            .join(QualityWorkItem)
            .where(
                QualityWorkItem.project_id == project_id,
                QualityResponse.is_current.is_(True),
            )
        )
    )
    add_sheet(
        workbook,
        "Quality assessment",
        ["Publication ID", "Reviewer ID", "Form version", "Answers", "Total score"],
        [
            [
                item.work_item.publication_id,
                item.reviewer_id,
                item.form_version_id,
                item.answers,
                item.total_score,
            ]
            for item in quality
        ],
    )


def build_prisma_tables(db: Session, project_id: str) -> bytes:
    """A standalone PRISMA counts + full-text exclusions workbook.

    Distinct from the full "xlsx" project export (§22.1) -- this is the
    "PRISMA supporting tables" export item (§22.2), for reviewers who only
    need the PRISMA numbers without the rest of the project data.
    """
    project = db.get(Project, project_id)
    if project is None:
        raise ValueError("Project not found")
    counts = calculate_prisma_counts(db, project_id)
    workbook = Workbook()
    workbook.remove(workbook.active)
    add_sheet(
        workbook,
        "PRISMA counts",
        ["Item", "Count"],
        [[key, value] for key, value in counts.items()],
    )
    buffer = BytesIO()
    workbook.save(buffer)
    return buffer.getvalue()


def _add_audit_sheet(db: Session, workbook: Workbook, project_id: str) -> None:
    events = list(
        db.scalars(
            select(AuditEvent)
            .where(AuditEvent.project_id == project_id)
            .order_by(AuditEvent.created_at)
        )
    )
    add_sheet(
        workbook,
        "Audit history",
        ["Timestamp", "User", "Action", "Entity", "Entity ID", "Summary"],
        [
            [
                event.created_at,
                event.actor_id,
                event.action,
                event.entity_type,
                event.entity_id,
                event.summary,
            ]
            for event in events
        ],
    )
