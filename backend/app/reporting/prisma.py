from __future__ import annotations

from xml.sax.saxutils import escape as xml_escape

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.conflicts.models import FinalDecision
from app.deduplication.models import PublicationMerge
from app.fulltext.models import FullTextRetrieval, RetrievalStatus
from app.imports.models import ImportBatch, ImportedRecord
from app.projects.models import ScreeningStage
from app.publications.models import Publication, PublicationSource
from app.screening.models import ScreeningOutcome


def calculate_prisma_counts(
    db: Session,
    project_id: str,
) -> dict[str, int]:
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
                Publication.is_active.is_(True),
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
        "includedPublications": sum(
            item.outcome == ScreeningOutcome.INCLUDE for item in full_finals
        ),
    }


def build_prisma_svg(project_name: str, counts: dict) -> str:  # noqa: C901
    """Render a classic PRISMA 2020 flow diagram: one centered column carrying
    records through identification -> screening -> eligibility -> included,
    with each stage's exclusions (duplicates, records excluded, reports not
    retrieved, reports excluded) branching off to the side rather than sitting
    inline in the main flow."""
    excluded_at_eligibility = max(
        counts["reportsAssessed"] - counts["includedPublications"], 0
    )

    stage_bar_x, stage_bar_width = 16, 26
    main_x = stage_bar_x + stage_bar_width + 14
    main_width = 300
    main_center = main_x + main_width / 2
    side_x = main_x + main_width + 46
    side_width = 220
    row_height = 60
    row_gap = 48
    top_margin = 64
    canvas_width = side_x + side_width + 24

    def esc(text: object) -> str:
        return xml_escape(str(text))

    def box(
        x: float,
        y: float,
        width: float,
        lines: list[str],
        *,
        font_size: int = 13,
        height: float = row_height,
    ) -> str:
        line_height = font_size + 5
        start_y = y + height / 2 - (len(lines) - 1) * line_height / 2 + font_size / 3
        text_els = "".join(
            f'<text x="{x + width / 2}" y="{start_y + i * line_height}" '
            f'text-anchor="middle" font-family="sans-serif" font-size="{font_size}">'
            f"{esc(line)}</text>"
            for i, line in enumerate(lines)
        )
        return (
            f'<rect x="{x}" y="{y}" width="{width}" height="{height}" rx="8" '
            'fill="white" stroke="#334155" stroke-width="1.5"/>' + text_els
        )

    def down_arrow(x1: float, y1: float, x2: float, y2: float) -> str:
        return (
            f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="#334155" '
            'stroke-width="1.5" marker-end="url(#arrow)"/>'
        )

    def right_arrow(x1: float, y: float, x2: float) -> str:
        return (
            f'<line x1="{x1}" y1="{y}" x2="{x2}" y2="{y}" stroke="#334155" '
            'stroke-width="1.5" marker-end="url(#arrow)"/>'
        )

    def stage_bar(y: float, height: float, label: str) -> str:
        inset = 6
        bar_y = y + inset
        bar_height = height - inset * 2
        cx, cy = stage_bar_x + stage_bar_width / 2, bar_y + bar_height / 2
        return (
            f'<rect data-stage="{esc(label)}" x="{stage_bar_x}" y="{bar_y}" '
            f'width="{stage_bar_width}" height="{bar_height}" rx="4" fill="#334155"/>'
            f'<text x="{cx}" y="{cy}" text-anchor="middle" dominant-baseline="central" '
            'font-family="sans-serif" font-size="12" font-weight="bold" fill="white" '
            f'transform="rotate(-90 {cx} {cy})">{esc(label)}</text>'
        )

    # Main-flow rows, top to bottom. Deduplication gets its own row (and
    # stage bar) between identification and screening, rather than sharing
    # the gap beneath "Identification" -- it's a distinct step, not an
    # annotation on the step before it.
    y_identified = top_margin
    y_dedup = y_identified + row_height + row_gap
    y_screened = y_dedup + row_height + row_gap
    y_sought = y_screened + row_height + row_gap
    y_assessed = y_sought + row_height + row_gap
    y_included = y_assessed + row_height + row_gap
    total_height = y_included + row_height + 30

    half_width = (main_width - 16) / 2

    parts: list[str] = [
        '<rect width="100%" height="100%" fill="#f8fafc"/>',
        f'<text x="{canvas_width / 2}" y="32" text-anchor="middle" '
        'font-family="sans-serif" font-size="18" font-weight="bold">'
        f"{esc(project_name)}</text>",
        # Bars occupy most of each stage (including the flow gap), with a small
        # inset so adjacent stage labels remain visually distinct.
        stage_bar(y_identified, y_dedup - y_identified, "Identification"),
        stage_bar(y_dedup, y_screened - y_dedup, "Duplicates"),
        stage_bar(y_screened, y_sought - y_screened, "Screening"),
        stage_bar(y_sought, y_included - y_sought, "Eligibility"),
        stage_bar(y_included, row_height + 20, "Included"),
    ]

    # Identification: two boxes side by side, both feeding down into the
    # deduplication row before reaching "Records screened".
    box_a_x, box_b_x = main_x, main_x + half_width + 16
    parts.append(
        box(
            box_a_x,
            y_identified,
            half_width,
            [
                "Records identified",
                "through database",
                f"searching (n={counts['recordsIdentifiedDatabases']})",
            ],
            font_size=11,
        )
    )
    parts.append(
        box(
            box_b_x,
            y_identified,
            half_width,
            [
                "Additional records",
                "identified through",
                f"other sources (n={counts['recordsIdentifiedOtherSources']})",
            ],
            font_size=11,
        )
    )
    parts.append(
        down_arrow(
            box_a_x + half_width / 2,
            y_identified + row_height,
            main_center,
            y_dedup,
        )
    )
    parts.append(
        down_arrow(
            box_b_x + half_width / 2,
            y_identified + row_height,
            main_center,
            y_dedup,
        )
    )
    records_checked = (
        counts["recordsIdentifiedDatabases"] + counts["recordsIdentifiedOtherSources"]
    )
    parts.append(
        box(
            main_x,
            y_dedup,
            main_width,
            [
                "Records checked",
                f"(n={records_checked})",
            ],
            font_size=12,
        )
    )
    parts.append(right_arrow(main_x + main_width, y_dedup + row_height / 2, side_x))
    parts.append(
        box(
            side_x,
            y_dedup,
            side_width,
            [
                f"Duplicate records removed (n={counts['duplicatesRemoved']})",
            ],
            font_size=12,
        )
    )
    parts.append(down_arrow(main_center, y_dedup + row_height, main_center, y_screened))

    def main_row_with_side(
        y: float, main_lines: list[str], side_label: str, next_y: float | None
    ) -> None:
        parts.append(box(main_x, y, main_width, main_lines, font_size=12))
        parts.append(right_arrow(main_x + main_width, y + row_height / 2, side_x))
        parts.append(box(side_x, y, side_width, [side_label], font_size=12))
        if next_y is not None:
            parts.append(down_arrow(main_center, y + row_height, main_center, next_y))

    main_row_with_side(
        y_screened,
        ["Records screened", f"(n={counts['recordsScreened']})"],
        f"Records excluded (n={counts['recordsExcluded']})",
        y_sought,
    )
    main_row_with_side(
        y_sought,
        ["Reports sought for retrieval", f"(n={counts['reportsSought']})"],
        f"Reports not retrieved (n={counts['reportsNotRetrieved']})",
        y_assessed,
    )
    main_row_with_side(
        y_assessed,
        ["Reports assessed for eligibility", f"(n={counts['reportsAssessed']})"],
        f"Reports excluded (n={excluded_at_eligibility})",
        y_included,
    )
    parts.append(
        box(
            main_x,
            y_included,
            main_width,
            [
                "Studies included in review",
                f"(n={counts['includedPublications']})",
            ],
            font_size=12,
        )
    )

    title = esc(project_name)
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{canvas_width}" '
        f'height="{total_height}" viewBox="0 0 {canvas_width} {total_height}" '
        f'role="img" aria-label="PRISMA 2020 flow diagram for {title}">'
        '<defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="4" '
        'refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#334155"/>'
        f'</marker></defs>{"".join(parts)}</svg>'
    )
