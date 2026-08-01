from datetime import date
from io import BytesIO

import pytest
from openpyxl import load_workbook
from sqlalchemy import select

from app.accounts.service import create_user
from app.conflicts.service import record_final_decision
from app.extraction.models import ExtractionWorkItem
from app.extraction.service import initialize_extraction, submit_extraction
from app.forms.models import FormKind
from app.forms.service import add_field, create_form
from app.fulltext.models import FullTextRetrieval, RetrievalStatus
from app.imports.models import ImportBatch, ImportedRecord, ImportStatus, SearchSource
from app.projects.models import (
    Project,
    ProjectMembership,
    ReviewType,
    ScreeningStage,
)
from app.publications.models import Publication
from app.publications.service import normalize_imported_records
from app.quality.models import QualityConfig, QualityWorkItem
from app.quality.service import initialize_quality, submit_quality
from app.reporting.service import (
    build_bibtex,
    build_excel,
    build_final_results,
    build_prisma_svg,
    build_prisma_tables,
    calculate_prisma_counts,
)


def setup_report(db):
    admin = create_user(db, "admin", "Admin", "secret-password", is_admin=True)
    project = Project(
        name="Review", review_type=ReviewType.SYSTEMATIC_REVIEW, random_seed="seed"
    )
    db.add(project)
    db.flush()
    search = SearchSource(
        project_id=project.id,
        source_name="IEEE",
        query="VR",
        search_date=date(2026, 7, 30),
        filters=None,
        exported_result_count=3,
        created_by_id=admin.id,
    )
    db.add(search)
    db.flush()
    batch = ImportBatch(
        project_id=project.id,
        search_source_id=search.id,
        original_filename="x.csv",
        stored_path="/tmp/x",
        file_type="csv",
        status=ImportStatus.COMPLETED,
        created_by_id=admin.id,
    )
    db.add(batch)
    db.flush()
    for i in range(3):
        db.add(
            ImportedRecord(
                import_batch_id=batch.id,
                source_row=i + 2,
                raw_data={},
                parsed_data={"title": f"Paper {i}"},
                validation_state="valid",
                warnings=[],
            )
        )
    included = Publication(
        project_id=project.id,
        title="=Dangerous title",
        authors="Doe, Jane",
        publication_year=2026,
        doi="10.1/include",
    )
    excluded = Publication(project_id=project.id, title="Excluded", authors="Roe, John")
    unavailable = Publication(project_id=project.id, title="Unavailable")
    db.add_all([included, excluded, unavailable])
    db.flush()
    for pub in (included, unavailable):
        record_final_decision(
            db,
            pub.id,
            ScreeningStage.TITLE_ABSTRACT,
            "include",
            "agreement",
            None,
            None,
        )
    record_final_decision(
        db,
        excluded.id,
        ScreeningStage.TITLE_ABSTRACT,
        "exclude",
        "agreement",
        None,
        None,
    )
    db.add(
        FullTextRetrieval(
            project_id=project.id,
            publication_id=included.id,
            status=RetrievalStatus.AVAILABLE,
        )
    )
    db.add(
        FullTextRetrieval(
            project_id=project.id,
            publication_id=unavailable.id,
            status=RetrievalStatus.NOT_FOUND,
        )
    )
    record_final_decision(
        db, included.id, ScreeningStage.FULL_TEXT, "include", "agreement", None, None
    )
    db.commit()
    return project, included


def test_prisma_counts_and_svg_are_derived_from_records(db) -> None:
    project, _ = setup_report(db)
    counts = calculate_prisma_counts(db, project.id)
    assert counts["recordsIdentifiedDatabases"] == 3
    assert counts["recordsExcluded"] == 1
    assert counts["reportsSought"] == 2
    assert counts["reportsNotRetrieved"] == 1
    assert counts["includedPublications"] == 1
    svg = build_prisma_svg(project.name, counts)
    assert svg.startswith("<svg")
    assert "Records identified" in svg
    assert ">3<" in svg


def test_excel_and_bibtex_exports_are_valid_and_safe(db) -> None:
    project, included = setup_report(db)
    workbook_bytes = build_excel(db, project.id)
    workbook = load_workbook(BytesIO(workbook_bytes), data_only=False)
    assert {"Project overview", "Normalized records", "Included publications"}.issubset(
        workbook.sheetnames
    )
    sheet = workbook["Normalized records"]
    values = [cell.value for row in sheet.iter_rows() for cell in row]
    assert "'=Dangerous title" in values

    bibtex = build_bibtex(db, project.id, scope="included")
    assert "@article" in bibtex
    assert "10.1/include" in bibtex
    assert included.title in bibtex


def test_excel_normalized_records_link_back_to_their_search_import(db) -> None:
    project, _included = setup_report(db)
    batch = db.scalar(select(ImportBatch).where(ImportBatch.project_id == project.id))
    normalize_imported_records(db, batch.id)
    db.commit()

    workbook_bytes = build_excel(db, project.id)
    workbook = load_workbook(BytesIO(workbook_bytes), data_only=False)
    sheet = workbook["Normalized records"]
    header = [cell.value for cell in next(sheet.iter_rows(max_row=1))]
    assert header[-2:] == ["Search sources", "Import files"]

    rows = {
        row[1].value: row
        for row in sheet.iter_rows(min_row=2)
        if row[1].value and row[1].value.startswith("Paper ")
    }
    assert rows
    for row in rows.values():
        assert row[header.index("Search sources")].value == "IEEE"
        assert row[header.index("Import files")].value == "x.csv"


def test_bibtex_custom_scope_filters_by_status(db) -> None:
    project, _included = setup_report(db)

    bibtex = build_bibtex(
        db,
        project.id,
        scope="custom",
        status_filter={"outcome": "exclude", "stage": "title_abstract"},
    )
    assert "Excluded" in bibtex
    assert "=Dangerous title" not in bibtex


def test_bibtex_custom_scope_without_outcome_is_rejected(db) -> None:
    project, _included = setup_report(db)
    with pytest.raises(ValueError):
        build_bibtex(db, project.id, scope="custom", status_filter={})


def test_bibtex_unrecognized_scope_is_rejected_rather_than_returning_everything(
    db,
) -> None:
    project, _included = setup_report(db)
    with pytest.raises(ValueError):
        build_bibtex(db, project.id, scope="not_a_real_scope")


def test_prisma_tables_export_is_a_standalone_workbook(db) -> None:
    project, _included = setup_report(db)

    workbook = load_workbook(BytesIO(build_prisma_tables(db, project.id)))
    assert workbook.sheetnames == ["PRISMA counts"]
    counts_sheet = workbook["PRISMA counts"]
    keys = [row[0].value for row in counts_sheet.iter_rows(min_row=2)]
    assert "recordsExcluded" in keys


def setup_final_results(db, quality_enabled=True):
    reviewer = create_user(db, "reviewer", "Reviewer", "reviewer-password")
    project = Project(
        name="Review", review_type=ReviewType.SYSTEMATIC_REVIEW, random_seed="seed"
    )
    db.add(project)
    db.flush()
    db.add(
        ProjectMembership(
            project_id=project.id,
            user_id=reviewer.id,
            can_extract=True,
            can_assess_quality=True,
        )
    )
    extraction_form = create_form(
        db, "Extraction", FormKind.EXTRACTION, project_id=project.id
    )
    finding_field = add_field(
        db, extraction_form, "Main finding", "long_text", required=True
    )
    db.add(
        QualityConfig(
            project_id=project.id,
            enabled=quality_enabled,
            mode="both",
            aggregation="sum",
        )
    )
    quality_field = None
    if quality_enabled:
        quality_form = create_form(
            db, "Quality", FormKind.QUALITY, project_id=project.id
        )
        quality_field = add_field(
            db, quality_form, "Rigor", "rating", required=True, scoring={"weight": 1}
        )
    complete_pub = Publication(project_id=project.id, title="Complete Paper")
    pending_pub = Publication(project_id=project.id, title="Pending Paper")
    db.add_all([complete_pub, pending_pub])
    db.flush()
    for pub in (complete_pub, pending_pub):
        record_final_decision(
            db,
            pub.id,
            ScreeningStage.FULL_TEXT,
            "include",
            "agreement",
            None,
            None,
        )
    db.commit()
    initialize_extraction(db, project)
    initialize_quality(db, project)
    db.commit()

    extraction_item = db.scalar(
        select(ExtractionWorkItem).where(
            ExtractionWorkItem.publication_id == complete_pub.id
        )
    )
    submit_extraction(
        db, extraction_item, reviewer.id, {finding_field.stable_key: "It works"}
    )
    if quality_enabled:
        quality_item = db.scalar(
            select(QualityWorkItem).where(
                QualityWorkItem.publication_id == complete_pub.id
            )
        )
        submit_quality(db, quality_item, reviewer.id, {quality_field.stable_key: 4})
    db.commit()
    return project, complete_pub, pending_pub, finding_field, quality_field


def test_final_results_reports_extraction_and_quality_answers(db) -> None:
    (
        project,
        complete_pub,
        pending_pub,
        finding_field,
        quality_field,
    ) = setup_final_results(db)

    result = build_final_results(db, project.id)

    assert result["qualityEnabled"] is True
    assert [field["stableKey"] for field in result["extractionFields"]] == [
        finding_field.stable_key
    ]
    assert [field["stableKey"] for field in result["qualityFields"]] == [
        quality_field.stable_key
    ]
    by_title = {item["publication"]["title"]: item for item in result["items"]}
    assert set(by_title) == {"Complete Paper", "Pending Paper"}

    complete = by_title["Complete Paper"]
    assert complete["extraction"]["status"] == "completed"
    assert complete["extraction"]["answers"] == {finding_field.stable_key: "It works"}
    assert complete["quality"]["status"] == "completed"
    assert complete["quality"]["totalScore"] == 4
    assert complete["quality"]["answers"] == {quality_field.stable_key: 4}

    pending = by_title["Pending Paper"]
    assert pending["extraction"]["status"] == "available"
    assert pending["extraction"]["answers"] == {}
    assert pending["quality"]["status"] == "available"


def test_final_results_omits_quality_when_disabled(db) -> None:
    project, *_ = setup_final_results(db, quality_enabled=False)

    result = build_final_results(db, project.id)

    assert result["qualityEnabled"] is False
    assert result["qualityFields"] == []
    for item in result["items"]:
        assert item["quality"] is None
