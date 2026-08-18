from __future__ import annotations

import json
from datetime import UTC, datetime
from io import BytesIO
from typing import Any

from openpyxl import Workbook
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.accounts.models import User
from app.audit.models import AuditEvent
from app.conflicts.models import FinalDecision
from app.deduplication.models import DuplicateCandidate
from app.extraction.final import get_current_final_extractions
from app.extraction.models import ExtractionResponse, ExtractionWorkItem
from app.forms.models import FormField, FormVersion, ReviewForm
from app.fulltext.models import FullTextRetrieval
from app.imports.models import ImportBatch, ImportedRecord, SearchSource
from app.projects.models import (
    Criterion,
    CriterionKind,
    Project,
    ResearchQuestion,
    ScreeningStage,
)
from app.publications.models import Publication, PublicationSource
from app.quality.models import QualityResponse, QualityWorkItem
from app.reporting.prisma import calculate_prisma_counts
from app.screening.models import ScreeningDecision, ScreeningOutcome, ScreeningWorkItem


def safe_cell(value: Any) -> Any:
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
    rows: list[list[Any]],
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


def _user_names(db: Session) -> dict[str, str]:
    return {
        row.id: row.display_name
        for row in db.execute(select(User.id, User.display_name))
    }


def _criterion_texts(db: Session, project_id: str) -> dict[str, str]:
    return {
        row.id: row.text
        for row in db.execute(
            select(Criterion.id, Criterion.text).where(
                Criterion.project_id == project_id
            )
        )
    }


def _form_version_labels(db: Session) -> dict[str, str]:
    rows = db.execute(
        select(FormVersion.id, FormVersion.version_number, ReviewForm.name).join(
            ReviewForm, ReviewForm.id == FormVersion.form_id
        )
    ).all()
    return {
        version_id: f"{name} v{version_number}"
        for version_id, version_number, name in rows
    }


def _form_field_labels(db: Session) -> dict[str, dict[str, str]]:
    labels: dict[str, dict[str, str]] = {}
    for field in db.scalars(select(FormField)):
        labels.setdefault(field.form_version_id, {})[field.stable_key] = field.label
    return labels


def _readable_answers(
    answers: dict[str, Any], field_labels: dict[str, str]
) -> dict[str, Any]:
    return {field_labels.get(key, key): value for key, value in answers.items()}


def _search_source_labels(publication: Publication) -> tuple[str | None, str | None]:
    sources = publication.search_sources
    source_names = ", ".join(
        dict.fromkeys(
            source["source_name"] for source in sources if source["source_name"]
        )
    )
    filenames = ", ".join(
        dict.fromkeys(source["original_filename"] for source in sources)
    )
    return source_names or None, filenames or None


def publication_rows(
    publications: list[Publication], titles: dict[str, str]
) -> list[list[Any]]:
    rows = []
    for publication in publications:
        source_names, filenames = _search_source_labels(publication)
        rows.append(
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
                (
                    titles.get(publication.merged_into_id, publication.merged_into_id)
                    if publication.merged_into_id
                    else None
                ),
                source_names,
                filenames,
            ]
        )
    return rows


def _screening_rows(
    decisions: list[ScreeningDecision],
    stage: ScreeningStage,
    titles: dict[str, str],
    user_names: dict[str, str],
    criterion_texts: dict[str, str],
) -> list[list[Any]]:
    return [
        [
            decision.work_item.publication_id,
            titles.get(
                decision.work_item.publication_id, decision.work_item.publication_id
            ),
            user_names.get(decision.reviewer_id, decision.reviewer_id),
            decision.outcome.value,
            {
                criterion_texts.get(key, key): value
                for key, value in decision.criteria_answers.items()
            },
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
    assert workbook.active is not None
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
    user_names = _user_names(db)
    _add_configuration_sheets(db, workbook, project_id)
    publications = _add_record_sheets(db, workbook, project_id)
    titles = {publication.id: publication.title for publication in publications}
    criterion_texts = _criterion_texts(db, project_id)
    included_ids = _add_screening_sheets(
        db, workbook, project_id, titles, user_names, criterion_texts
    )
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
        "Merged into ID",
        "Merged into title",
        "Search sources",
        "Import files",
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
            ],
            titles,
        ),
    )
    _add_evidence_sheets(db, workbook, project_id, titles, user_names)
    _add_audit_sheet(db, workbook, project_id, user_names)
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
            .options(
                selectinload(Publication.sources)
                .selectinload(PublicationSource.imported_record)
                .selectinload(ImportedRecord.import_batch)
                .selectinload(ImportBatch.search_source)
            )
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
        "Merged into ID",
        "Merged into title",
        "Search sources",
        "Import files",
    ]
    titles = {publication.id: publication.title for publication in publications}
    add_sheet(
        workbook, "Normalized records", headers, publication_rows(publications, titles)
    )
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
        [
            "ID",
            "Publication A ID",
            "Publication A title",
            "Publication B ID",
            "Publication B title",
            "Reasons",
            "Confidence",
            "Status",
        ],
        [
            [
                item.id,
                item.publication_a_id,
                titles.get(item.publication_a_id, item.publication_a_id),
                item.publication_b_id,
                titles.get(item.publication_b_id, item.publication_b_id),
                item.match_reasons,
                item.confidence,
                item.status,
            ]
            for item in candidates
        ],
    )
    return publications


def _add_screening_sheets(
    db: Session,
    workbook: Workbook,
    project_id: str,
    titles: dict[str, str],
    user_names: dict[str, str],
    criterion_texts: dict[str, str],
) -> set[str]:
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
        "Publication title",
        "Reviewer",
        "Outcome",
        "Criteria",
        "Notes",
        "Version",
    ]
    add_sheet(
        workbook,
        "Title abstract screening",
        headers,
        _screening_rows(
            decisions,
            ScreeningStage.TITLE_ABSTRACT,
            titles,
            user_names,
            criterion_texts,
        ),
    )
    retrievals = list(
        db.scalars(
            select(FullTextRetrieval).where(FullTextRetrieval.project_id == project_id)
        )
    )
    add_sheet(
        workbook,
        "Full text retrieval",
        ["Publication ID", "Publication title", "Status", "Note"],
        [
            [
                item.publication_id,
                titles.get(item.publication_id, item.publication_id),
                item.status.value,
                item.note,
            ]
            for item in retrievals
        ],
    )
    add_sheet(
        workbook,
        "Full text screening",
        headers,
        _screening_rows(
            decisions, ScreeningStage.FULL_TEXT, titles, user_names, criterion_texts
        ),
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
        [
            "Publication ID",
            "Publication title",
            "Stage",
            "Outcome",
            "Resolution",
            "Note",
        ],
        [
            [
                item.publication_id,
                titles.get(item.publication_id, item.publication_id),
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


def _add_evidence_sheets(
    db: Session,
    workbook: Workbook,
    project_id: str,
    titles: dict[str, str],
    user_names: dict[str, str],
) -> None:
    form_version_labels = _form_version_labels(db)
    field_labels = _form_field_labels(db)
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
        "Extraction (reviewer responses)",
        ["Publication ID", "Publication title", "Reviewer", "Form version", "Answers"],
        [
            [
                item.work_item.publication_id,
                titles.get(
                    item.work_item.publication_id, item.work_item.publication_id
                ),
                user_names.get(item.reviewer_id, item.reviewer_id),
                form_version_labels.get(item.form_version_id, item.form_version_id),
                _readable_answers(
                    item.answers, field_labels.get(item.form_version_id, {})
                ),
            ]
            for item in extraction
        ],
    )
    final_extractions = get_current_final_extractions(db, list(titles))
    add_sheet(
        workbook,
        "Extraction (final)",
        [
            "Publication ID",
            "Publication title",
            "Resolution method",
            "Resolved by",
            "Form version",
            "Answers",
        ],
        [
            [
                publication_id,
                titles.get(publication_id, publication_id),
                final.resolution_method,
                user_names.get(final.resolved_by_id, "") if final.resolved_by_id else "",
                form_version_labels.get(final.form_version_id, final.form_version_id),
                _readable_answers(
                    final.answers, field_labels.get(final.form_version_id, {})
                ),
            ]
            for publication_id, final in final_extractions.items()
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
        [
            "Publication ID",
            "Publication title",
            "Reviewer",
            "Form version",
            "Answers",
            "Total score",
        ],
        [
            [
                item.work_item.publication_id,
                titles.get(
                    item.work_item.publication_id, item.work_item.publication_id
                ),
                user_names.get(item.reviewer_id, item.reviewer_id),
                form_version_labels.get(item.form_version_id, item.form_version_id),
                _readable_answers(
                    item.answers, field_labels.get(item.form_version_id, {})
                ),
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
    assert workbook.active is not None
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


def _add_audit_sheet(
    db: Session, workbook: Workbook, project_id: str, user_names: dict[str, str]
) -> None:
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
                (
                    user_names.get(event.actor_id, event.actor_id)
                    if event.actor_id
                    else None
                ),
                event.action,
                event.entity_type,
                event.entity_id,
                event.summary,
            ]
            for event in events
        ],
    )
