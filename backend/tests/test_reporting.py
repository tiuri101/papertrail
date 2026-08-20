import zipfile
from datetime import date
from io import BytesIO
from pathlib import Path
from xml.etree import ElementTree

import pyarrow.parquet as parquet  # type: ignore[import-untyped]
import pytest
from openpyxl import load_workbook
from sqlalchemy import select

from app.accounts.models import User
from app.accounts.service import create_user
from app.conflicts.service import record_final_decision
from app.core.config import get_settings
from app.deduplication.models import PublicationMerge
from app.extraction.models import ExtractionConfig, ExtractionWorkItem
from app.extraction.service import initialize_extraction, submit_extraction
from app.forms.models import FormKind
from app.forms.service import add_field, create_form
from app.fulltext.models import FullTextRetrieval, PublicationDocument, RetrievalStatus
from app.imports.models import ImportBatch, ImportedRecord, ImportStatus, SearchSource
from app.jobs.models import BackgroundJob
from app.projects.models import (
    Project,
    ProjectMembership,
    ReviewType,
    ScreeningStage,
    TaskAllocationMode,
)
from app.publications.models import Publication
from app.publications.service import normalize_imported_records
from app.quality.models import QualityConfig, QualityWorkItem
from app.quality.service import initialize_quality, submit_quality
from app.reporting.jobs import generate_export_job
from app.reporting.models import ExportArtifact
from app.reporting.service import (
    build_bibtex,
    build_csv,
    build_excel,
    build_final_results,
    build_json,
    build_parquet,
    build_prisma_svg,
    build_prisma_tables,
    build_publication_bundle,
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
    # record_final_decision already created these rows immediately on
    # inclusion (see conflicts.service._queue_retrieval_on_inclusion); just
    # set the statuses this report fixture needs.
    included_retrieval = db.scalar(
        select(FullTextRetrieval).where(FullTextRetrieval.publication_id == included.id)
    )
    included_retrieval.status = RetrievalStatus.AVAILABLE
    unavailable_retrieval = db.scalar(
        select(FullTextRetrieval).where(
            FullTextRetrieval.publication_id == unavailable.id
        )
    )
    unavailable_retrieval.status = RetrievalStatus.NOT_FOUND
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
    assert "searching (n=3)" in svg
    assert "Records excluded (n=1)" in svg
    assert "Reports not retrieved (n=1)" in svg
    assert "Duplicate records removed" in svg
    assert "Records checked" in svg
    assert "Studies included in review" in svg
    assert ">Review</text>" in svg
    assert "Review — PRISMA 2020" not in svg

    root = ElementTree.fromstring(svg)
    stage_bars = {
        element.attrib["data-stage"]: element
        for element in root.findall("{http://www.w3.org/2000/svg}rect")
        if "data-stage" in element.attrib
    }
    ordered_stages = [
        "Identification",
        "Duplicates",
        "Screening",
        "Eligibility",
        "Included",
    ]
    for current, following in zip(ordered_stages, ordered_stages[1:], strict=False):
        current_bar = stage_bars[current]
        following_bar = stage_bars[following]
        current_bottom = float(current_bar.attrib["y"]) + float(
            current_bar.attrib["height"]
        )
        assert float(following_bar.attrib["y"]) - current_bottom >= 10


def test_prisma_counts_do_not_treat_merged_publications_as_other_sources(db) -> None:
    project, canonical = setup_report(db)
    merged = Publication(
        project_id=project.id,
        title="Merged duplicate",
        is_active=False,
        merged_into_id=canonical.id,
    )
    db.add(merged)
    db.flush()
    db.add(
        PublicationMerge(
            project_id=project.id,
            canonical_publication_id=canonical.id,
            merged_publication_id=merged.id,
            canonical_before={},
            merged_before={},
            moved_source_ids=[],
            moved_document_states=[],
        )
    )
    db.commit()

    counts = calculate_prisma_counts(db, project.id)

    assert counts["recordsIdentifiedOtherSources"] == 3
    assert counts["duplicatesRemoved"] == 1


def test_prisma_svg_route_returns_the_figure_inline(client, db) -> None:
    project, _ = setup_report(db)

    csrf = client.post(
        "/api/v1/auth/login", json={"username": "admin", "password": "secret-password"}
    ).json()["csrfToken"]
    response = client.get(
        f"/api/v1/projects/{project.id}/prisma/svg", headers={"X-CSRF-Token": csrf}
    )

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("image/svg+xml")
    assert response.headers["cache-control"] == "no-store"
    assert response.text.startswith("<svg")
    assert "Records identified" in response.text


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


def test_parquet_export_is_analysis_ready_and_preserves_dynamic_answers(db) -> None:
    project, included = setup_report(db)
    data = build_parquet(db, project.id)
    table = parquet.read_table(BytesIO(data))

    assert "title" in table.column_names
    assert "publication_year" in table.column_names
    assert included.title in table.column("title").to_pylist()
    assert str(table.schema.field("publication_year").type) == "int64"


def test_json_and_csv_exports_are_interoperable(db) -> None:
    project, included = setup_report(db)

    json_data = build_json(db, project.id)
    assert included.title in json_data.decode("utf-8")
    assert '"items"' in json_data.decode("utf-8")

    csv_data = build_csv(db, project.id).decode("utf-8-sig")
    assert "publication_id,title,authors" in csv_data
    assert included.title in csv_data


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


def test_bibtex_selected_scope_filters_by_publication_ids(db) -> None:
    project, included = setup_report(db)
    excluded = db.scalar(select(Publication).where(Publication.title == "Excluded"))
    assert excluded is not None

    bibtex = build_bibtex(
        db, project.id, scope="selected", publication_ids=[included.id]
    )

    assert included.title in bibtex
    assert "Excluded" not in bibtex


def test_bibtex_selected_scope_requires_publication_ids(db) -> None:
    project, _included = setup_report(db)
    with pytest.raises(ValueError):
        build_bibtex(db, project.id, scope="selected", publication_ids=[])


def _attach_pdf(db, project, publication, sha_prefix: str) -> Path:
    admin = db.scalar(select(User).where(User.username == "admin"))
    settings = get_settings()
    storage_key = f"projects/{project.id}/publications/{publication.id}/document.pdf"
    path = settings.pdf_storage_path / storage_key
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"%PDF-1.4 fake pdf content")
    db.add(
        PublicationDocument(
            project_id=project.id,
            publication_id=publication.id,
            original_filename="document.pdf",
            storage_key=storage_key,
            mime_type="application/pdf",
            file_size=path.stat().st_size,
            sha256=sha_prefix * 64,
            uploaded_by_user_id=admin.id,
        )
    )
    return path


def test_publication_bundle_includes_pdfs_and_lists_missing_ones(
    db, tmp_path: Path
) -> None:
    project, included = setup_report(db)
    unavailable = db.scalar(
        select(Publication).where(Publication.title == "Unavailable")
    )
    assert unavailable is not None

    settings = get_settings()
    original_pdf_path = settings.pdf_storage_path
    settings.pdf_storage_path = tmp_path
    try:
        _attach_pdf(db, project, included, "a")
        db.commit()

        data = build_publication_bundle(db, project.id, [included.id, unavailable.id])
    finally:
        settings.pdf_storage_path = original_pdf_path

    with zipfile.ZipFile(BytesIO(data)) as archive:
        names = archive.namelist()
        assert "metadata.bib" in names
        assert "MISSING_PDFS.txt" in names
        pdf_names = [name for name in names if name.endswith(".pdf")]
        assert len(pdf_names) == 1
        assert included.title in archive.read("metadata.bib").decode()
        assert unavailable.title in archive.read("MISSING_PDFS.txt").decode()


def test_export_job_generates_a_pdf_bundle_artifact(db, tmp_path: Path) -> None:
    project, included = setup_report(db)
    admin = db.scalar(select(User).where(User.username == "admin"))

    settings = get_settings()
    original_export_dir = settings.export_dir
    original_pdf_path = settings.pdf_storage_path
    settings.export_dir = tmp_path / "exports"
    settings.pdf_storage_path = tmp_path / "pdfs"
    try:
        _attach_pdf(db, project, included, "b")
        job = BackgroundJob(
            project_id=project.id,
            job_type="generate_export",
            payload={"export_type": "pdf_bundle", "publication_ids": [included.id]},
            created_by_id=admin.id,
        )
        db.add(job)
        db.commit()

        result = generate_export_job(db, job)
        db.commit()
    finally:
        settings.export_dir = original_export_dir
        settings.pdf_storage_path = original_pdf_path

    artifact = db.query(ExportArtifact).filter_by(job_id=job.id).one()
    assert result["artifactId"] == artifact.id
    assert artifact.filename.endswith(".zip")
    with zipfile.ZipFile(artifact.stored_path) as archive:
        assert "metadata.bib" in archive.namelist()


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
        ExtractionConfig(
            project_id=project.id, allocation_mode=TaskAllocationMode.PRE_ASSIGNED
        )
    )
    db.add(
        QualityConfig(
            project_id=project.id,
            enabled=quality_enabled,
            mode="both",
            aggregation="sum",
            allocation_mode=TaskAllocationMode.PRE_ASSIGNED,
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


def test_final_results_use_reconciled_value_not_an_arbitrary_response(db) -> None:
    """Dual-extraction mode: build_final_results must show the reconciled
    consensus value, and must never present an unresolved disagreement as
    though it were final."""
    from app.conflicts.service import record_final_decision
    from app.extraction.service import (
        claim_next_extraction,
        extraction_required_reviewers,
    )
    from app.projects.models import ProjectStage

    admin = create_user(db, "admin", "Admin", "secret-password", is_admin=True)
    r1 = create_user(db, "r1", "R1", "password-1")
    r2 = create_user(db, "r2", "R2", "password-2")
    project = Project(
        name="Dual",
        review_type=ReviewType.SYSTEMATIC_REVIEW,
        random_seed="seed",
        stage=ProjectStage.FULL_TEXT,
    )
    db.add(project)
    db.flush()
    for reviewer in (r1, r2):
        db.add(
            ProjectMembership(
                project_id=project.id, user_id=reviewer.id, can_extract=True
            )
        )
    db.add(ExtractionConfig(project_id=project.id, required_reviewers=2))
    form = create_form(db, "Extraction", FormKind.EXTRACTION, project_id=project.id)
    field = add_field(
        db,
        form,
        "Outcome",
        "single_select",
        required=True,
        options=["Positive", "Negative"],
    )
    resolved_pub = Publication(project_id=project.id, title="Resolved paper")
    pending_pub = Publication(project_id=project.id, title="Still disagreeing paper")
    db.add_all([resolved_pub, pending_pub])
    db.flush()
    for pub in (resolved_pub, pending_pub):
        record_final_decision(
            db, pub.id, ScreeningStage.FULL_TEXT, "include", "agreement", None, None
        )
    project.stage = ProjectStage.EXTRACTION
    db.commit()
    initialize_extraction(db, project)
    db.commit()
    assert extraction_required_reviewers(db, project.id) == 2

    def claim_for_publication(reviewer_id, publication_id):
        excluded: set[str] = set()
        for _ in range(10):
            item = claim_next_extraction(db, project.id, reviewer_id, excluded)
            assert item is not None
            if item.publication_id == publication_id:
                return item
            excluded.add(item.id)
        raise AssertionError("could not claim the target publication's slot")

    # Which reviewer's submission ends up as reconciliation's "response_a" is
    # defined by slot_number, not by claim order/reviewer identity.
    slot1_value_by_publication: dict[str, str] = {}
    for pub, value_r1, value_r2 in (
        (resolved_pub, "Positive", "Negative"),
        (pending_pub, "Positive", "Negative"),
    ):
        item_r1 = claim_for_publication(r1.id, pub.id)
        submit_extraction(db, item_r1, r1.id, {field.stable_key: value_r1})
        item_r2 = claim_for_publication(r2.id, pub.id)
        submit_extraction(db, item_r2, r2.id, {field.stable_key: value_r2})
        slot1_value_by_publication[pub.id] = (
            value_r1 if item_r1.slot_number == 1 else value_r2
        )
    db.commit()

    from app.extraction.reconciliation import submit_reconciliation

    submit_reconciliation(
        db,
        resolved_pub.id,
        admin.id,
        {field.stable_key: {"choice": "response_a"}},
        "Checked against source",
    )
    db.commit()

    result = build_final_results(db, project.id)
    by_title = {item["publication"]["title"]: item for item in result["items"]}

    resolved = by_title["Resolved paper"]
    assert resolved["extraction"]["status"] == "completed"
    assert resolved["extraction"]["resolutionMethod"] == "reconciliation"
    assert resolved["extraction"]["answers"] == {
        field.stable_key: slot1_value_by_publication[resolved_pub.id]
    }

    still_pending = by_title["Still disagreeing paper"]
    assert still_pending["extraction"]["status"] == "reconciliation_pending"
    assert still_pending["extraction"]["answers"] == {}
