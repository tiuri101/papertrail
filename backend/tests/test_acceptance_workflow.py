from datetime import date

from sqlalchemy import select

from app.accounts.service import create_user
from app.conflicts.service import (
    refresh_automatic_final_decision,
    transition_if_screening_complete,
)
from app.extraction.service import claim_next_extraction, submit_extraction
from app.forms.models import FieldType, FormKind
from app.forms.service import add_field, create_form
from app.fulltext.models import FullTextRetrieval, RetrievalStatus
from app.fulltext.service import set_retrieval_status
from app.imports.models import ImportBatch, ImportStatus, SearchSource
from app.imports.service import process_import_job
from app.jobs.models import BackgroundJob
from app.projects.lifecycle import evaluate_project_completion
from app.projects.models import (
    Criterion,
    CriterionKind,
    ProjectMembership,
    ProjectStage,
    ReviewType,
    ScreeningStage,
)
from app.projects.service import create_project
from app.publications.models import Publication
from app.quality.models import QualityConfig
from app.reporting.service import (
    build_bibtex,
    build_excel,
    build_prisma_svg,
    calculate_prisma_counts,
)
from app.screening.service import (
    claim_next_work_item,
    create_screening_work_items,
    submit_decision,
)


def test_complete_review_workflow_produces_exports(db, tmp_path) -> None:
    admin = create_user(db, "admin", "Administrator", "secret-password", is_admin=True)
    reviewer = create_user(db, "reviewer", "Reviewer", "secret-password")
    project = create_project(
        db, "Acceptance Review", None, ReviewType.SYSTEMATIC_REVIEW, admin
    )
    # The owner is a full reviewer by default; this workflow exercises the
    # single invited reviewer doing all the work, so keep the owner out of
    # the eligible-reviewer pool for these stages.
    owner_membership = db.scalar(
        select(ProjectMembership).where(
            ProjectMembership.project_id == project.id,
            ProjectMembership.user_id == admin.id,
        )
    )
    owner_membership.can_title_abstract_screen = False
    owner_membership.can_full_text_screen = False
    owner_membership.can_extract = False
    db.add(
        ProjectMembership(
            project_id=project.id,
            user_id=reviewer.id,
            can_title_abstract_screen=True,
            can_full_text_screen=True,
            can_extract=True,
        )
    )
    criterion = Criterion(
        project_id=project.id,
        kind=CriterionKind.INCLUSION,
        text="Relevant to the review",
        position=0,
    )
    db.add(criterion)
    extraction_form = create_form(
        db,
        "Extraction",
        FormKind.EXTRACTION,
        project_id=project.id,
    )
    finding_field = add_field(
        db,
        extraction_form,
        "Main finding",
        FieldType.LONG_TEXT,
        required=True,
    )
    db.add(QualityConfig(project_id=project.id, enabled=False))
    db.flush()

    source = SearchSource(
        project_id=project.id,
        source_name="IEEE Xplore",
        query="virtual reality AND urban",
        search_date=date(2026, 7, 30),
        filters=None,
        exported_result_count=1,
        created_by_id=admin.id,
    )
    db.add(source)
    db.flush()
    import_path = tmp_path / "records.csv"
    import_path.write_text(
        "Title,Authors,Abstract,DOI\nPaper A,Doe Jane,Useful abstract,10.1000/a\n",
        encoding="utf-8",
    )
    batch = ImportBatch(
        project_id=project.id,
        search_source_id=source.id,
        original_filename=import_path.name,
        stored_path=str(import_path),
        file_type="csv",
        status=ImportStatus.PENDING,
        created_by_id=admin.id,
    )
    db.add(batch)
    db.flush()
    import_job = BackgroundJob(
        project_id=project.id,
        job_type="parse_import",
        payload={"import_batch_id": batch.id},
        created_by_id=admin.id,
    )
    db.add(import_job)
    db.commit()

    process_import_job(db, import_job)
    publication = db.scalar(
        select(Publication).where(Publication.project_id == project.id)
    )
    assert publication is not None

    project.stage = ProjectStage.TITLE_ABSTRACT
    create_screening_work_items(db, project, ScreeningStage.TITLE_ABSTRACT)
    title_item = claim_next_work_item(
        db,
        project.id,
        ScreeningStage.TITLE_ABSTRACT,
        reviewer.id,
    )
    assert title_item is not None
    submit_decision(
        db,
        title_item,
        reviewer.id,
        "include",
        {criterion.id: True},
        None,
    )
    assert (
        refresh_automatic_final_decision(
            db,
            publication.id,
            ScreeningStage.TITLE_ABSTRACT,
        )
        is not None
    )
    assert (
        transition_if_screening_complete(
            db,
            project,
            ScreeningStage.TITLE_ABSTRACT,
        )
        is True
    )

    retrieval = db.scalar(
        select(FullTextRetrieval).where(
            FullTextRetrieval.publication_id == publication.id
        )
    )
    assert retrieval is not None
    set_retrieval_status(
        db,
        retrieval,
        RetrievalStatus.AVAILABLE,
        user_id=reviewer.id,
    )
    full_text_item = claim_next_work_item(
        db,
        project.id,
        ScreeningStage.FULL_TEXT,
        reviewer.id,
    )
    assert full_text_item is not None
    submit_decision(
        db,
        full_text_item,
        reviewer.id,
        "include",
        {criterion.id: True},
        None,
    )
    assert (
        refresh_automatic_final_decision(
            db,
            publication.id,
            ScreeningStage.FULL_TEXT,
        )
        is not None
    )
    assert (
        transition_if_screening_complete(
            db,
            project,
            ScreeningStage.FULL_TEXT,
        )
        is True
    )
    assert project.stage == ProjectStage.EXTRACTION

    extraction_item = claim_next_extraction(db, project.id, reviewer.id)
    assert extraction_item is not None
    submit_extraction(
        db,
        extraction_item,
        reviewer.id,
        {finding_field.stable_key: "The application supported the target task."},
    )
    assert evaluate_project_completion(db, project) is True
    assert project.stage == ProjectStage.COMPLETED

    counts = calculate_prisma_counts(db, project.id)
    assert counts["recordsIdentifiedDatabases"] == 1
    assert counts["includedPublications"] == 1
    assert build_prisma_svg(project.name, counts).startswith("<svg")
    assert build_excel(db, project.id).startswith(b"PK")
    assert "10.1000/a" in build_bibtex(db, project.id, scope="included")
