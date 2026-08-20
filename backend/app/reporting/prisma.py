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


def build_prisma_svg(project_name: str, counts: dict[str, int]) -> str:  # noqa: C901
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
    stage_font_size = 12
    min_bar_gap = 12

    def required_bar_height(label: str) -> float:
        # Per-character estimate (rotated bold sans-serif text can render
        # noticeably wider than Chromium's local font metrics depending on
        # the font available where the SVG is viewed/exported), plus
        # vertical padding so the label never overflows its bar.
        return len(label) * stage_font_size * 0.75 + 26

    def stage_gap(
        label_a: str, height_a: float, label_b: str, height_b: float
    ) -> float:
        # The minimum main-flow gap that keeps two adjacent stage bars from
        # overlapping: each bar's own overhang past its box group, plus
        # min_bar_gap of clearance. Solved per pair (rather than one shared
        # gap reused everywhere) so every stage bar sits exactly
        # min_bar_gap away from its neighbor, regardless of how much
        # taller one label's bar is than the next.
        overhang_a = max(0.0, required_bar_height(label_a) - height_a) / 2
        overhang_b = max(0.0, required_bar_height(label_b) - height_b) / 2
        return overhang_a + overhang_b + min_bar_gap

    top_margin = max(
        64, 40 + required_bar_height("Identification") / 2 - row_height / 2
    )
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

    # The arrow marker's tip sits past the line's own endpoint: marker
    # content spans x=0 (base) to x=8 (tip) with refX=4 aligned to the
    # line end, scaled by stroke-width (the default markerUnits), so the
    # tip lands (8 - 4) * 1.5 = 6 units beyond (x2, y2). x2/y2 below are
    # always given as the target box's edge, so every line is shortened by
    # that amount -- the tip then lands exactly on the edge instead of
    # poking into the box.
    arrow_tip_overhang = 6.0

    def down_arrow(x1: float, y1: float, x2: float, y2: float) -> str:
        y2 -= arrow_tip_overhang
        return (
            f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="#334155" '
            'stroke-width="1.5" marker-end="url(#arrow)"/>'
        )

    def right_arrow(x1: float, y: float, x2: float) -> str:
        x2 -= arrow_tip_overhang
        return (
            f'<line x1="{x1}" y1="{y}" x2="{x2}" y2="{y}" stroke="#334155" '
            'stroke-width="1.5" marker-end="url(#arrow)"/>'
        )

    def stage_bar(group_top: float, group_bottom: float, label: str) -> str:
        # Sized to comfortably fit the (rotated) label and centered on the
        # main-flow box group it labels, rather than stretching to fill
        # whatever flow gap happens to follow it.
        group_center = (group_top + group_bottom) / 2
        bar_height = max(group_bottom - group_top, required_bar_height(label))
        bar_y = group_center - bar_height / 2
        cx, cy = stage_bar_x + stage_bar_width / 2, group_center
        return (
            f'<rect data-stage="{esc(label)}" x="{stage_bar_x}" y="{bar_y}" '
            f'width="{stage_bar_width}" height="{bar_height}" rx="4" fill="#334155"/>'
            f'<text x="{cx}" y="{cy}" text-anchor="middle" dominant-baseline="central" '
            f'font-family="sans-serif" font-size="{stage_font_size}" font-weight="bold" '
            f'fill="white" transform="rotate(-90 {cx} {cy})">{esc(label)}</text>'
        )

    # "Reports sought" and "Reports assessed" share a single "Eligibility"
    # bar (no stage-bar boundary between them), so their gap isn't
    # constrained by bar overlap -- keep them close, matching the tight
    # spacing used everywhere else in the main flow.
    sought_assessed_gap = min_bar_gap * 2
    eligibility_group_height = 2 * row_height + sought_assessed_gap

    # Main-flow rows, top to bottom. Deduplication gets its own row (and
    # stage bar) between identification and screening, rather than sharing
    # the gap beneath "Identification" -- it's a distinct step, not an
    # annotation on the step before it. Every stage-bar-adjacent gap is
    # solved independently so the bars themselves sit a consistent
    # min_bar_gap apart throughout, however much their surrounding
    # main-flow gap has to grow to make room for a long label.
    y_identified = top_margin
    y_dedup = (
        y_identified
        + row_height
        + stage_gap("Identification", row_height, "Duplicates", row_height)
    )
    y_screened = (
        y_dedup
        + row_height
        + stage_gap("Duplicates", row_height, "Screening", row_height)
    )
    y_sought = (
        y_screened
        + row_height
        + stage_gap("Screening", row_height, "Eligibility", eligibility_group_height)
    )
    y_assessed = y_sought + row_height + sought_assessed_gap
    y_included = (
        y_assessed
        + row_height
        + stage_gap("Eligibility", eligibility_group_height, "Included", row_height)
    )
    bottom_bar_overhang = max(required_bar_height("Included") / 2 - row_height / 2, 0)
    total_height = y_included + row_height + 30 + bottom_bar_overhang

    half_width = (main_width - 16) / 2

    parts: list[str] = [
        '<rect width="100%" height="100%" fill="#f8fafc"/>',
        f'<text x="{canvas_width / 2}" y="32" text-anchor="middle" '
        'font-family="sans-serif" font-size="18" font-weight="bold">'
        f"{esc(project_name)}</text>",
        # Each bar spans (and is centered on) exactly the main-flow box(es)
        # it labels; "Eligibility" covers two rows ("Reports sought" and
        # "Reports assessed"), the rest cover a single row.
        stage_bar(y_identified, y_identified + row_height, "Identification"),
        stage_bar(y_dedup, y_dedup + row_height, "Duplicates"),
        stage_bar(y_screened, y_screened + row_height, "Screening"),
        stage_bar(y_sought, y_assessed + row_height, "Eligibility"),
        stage_bar(y_included, y_included + row_height, "Included"),
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
    # Land the two converging arrowheads a little apart on "Records
    # checked" rather than both tips landing on main_center, where they'd
    # overlap into a single blob.
    convergence_spread = 16
    parts.append(
        down_arrow(
            box_a_x + half_width / 2,
            y_identified + row_height,
            main_center - convergence_spread / 2,
            y_dedup,
        )
    )
    parts.append(
        down_arrow(
            box_b_x + half_width / 2,
            y_identified + row_height,
            main_center + convergence_spread / 2,
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
