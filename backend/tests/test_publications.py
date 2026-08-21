import datetime
from io import BytesIO

import pytest
from pypdf import PdfWriter
from sqlalchemy import select

from app.accounts.service import create_user
from app.audit.models import AuditEvent
from app.conflicts.service import record_final_decision
from app.core.config import get_settings
from app.extraction.models import ExtractionStatus, ExtractionWorkItem
from app.fulltext.models import FullTextRetrieval, RetrievalStatus
from app.imports.models import ImportBatch, ImportedRecord, ImportStatus, SearchSource
from app.projects.models import (
    AllocationMode,
    Criterion,
    CriterionKind,
    Project,
    ProjectMembership,
    ProjectStage,
    ReviewType,
    ScreeningConfig,
    ScreeningStage,
)
from app.publications.models import MetadataConflict, Publication, PublicationSource
from app.publications.service import (
    apply_enrichment,
    clean_text,
    normalize_imported_records,
)
from app.screening.models import (
    ScreeningDecision,
    ScreeningOutcome,
    ScreeningWorkItem,
    WorkItemStatus,
)


def login(client) -> str:
    response = client.post(
        "/api/v1/auth/login", json={"username": "admin", "password": "secret-password"}
    )
    return response.json()["csrfToken"]


@pytest.fixture(autouse=True)
def isolated_pdf_storage(tmp_path):
    settings = get_settings()
    previous = settings.pdf_storage_path
    settings.pdf_storage_path = tmp_path / "pdfs"
    settings.pdf_storage_path.mkdir()
    try:
        yield
    finally:
        settings.pdf_storage_path = previous


def pdf_bytes(title: str) -> bytes:
    stream = BytesIO()
    writer = PdfWriter()
    writer.add_blank_page(width=72, height=72)
    writer.add_metadata({"/Title": title})
    writer.write(stream)
    return stream.getvalue()


def test_delete_publication_soft_deletes_and_hides_it_from_the_list(client, db) -> None:
    create_user(db, "admin", "Administrator", "secret-password", is_admin=True)
    project = Project(
        name="Review", review_type=ReviewType.SYSTEMATIC_REVIEW, random_seed="seed"
    )
    db.add(project)
    db.commit()
    csrf = login(client)

    created = client.post(
        f"/api/v1/projects/{project.id}/publications",
        json={"title": "Paper to remove"},
        headers={"X-CSRF-Token": csrf},
    )
    assert created.status_code == 201
    publication_id = created.json()["id"]

    deleted = client.delete(
        f"/api/v1/projects/{project.id}/publications/{publication_id}",
        headers={"X-CSRF-Token": csrf},
    )
    assert deleted.status_code == 204

    listing = client.get(f"/api/v1/projects/{project.id}/publications")
    assert listing.json() == []
    assert (
        client.get(
            f"/api/v1/projects/{project.id}/publications/{publication_id}"
        ).status_code
        == 200
    )

    again = client.delete(
        f"/api/v1/projects/{project.id}/publications/{publication_id}",
        headers={"X-CSRF-Token": csrf},
    )
    assert again.status_code == 404


def test_bulk_delete_removes_only_the_selected_publications(client, db) -> None:
    create_user(db, "admin", "Administrator", "secret-password", is_admin=True)
    project = Project(
        name="Review", review_type=ReviewType.SYSTEMATIC_REVIEW, random_seed="seed"
    )
    db.add(project)
    db.commit()
    csrf = login(client)

    kept = client.post(
        f"/api/v1/projects/{project.id}/publications",
        json={"title": "Keep me"},
        headers={"X-CSRF-Token": csrf},
    ).json()
    removed_one = client.post(
        f"/api/v1/projects/{project.id}/publications",
        json={"title": "Remove me 1"},
        headers={"X-CSRF-Token": csrf},
    ).json()
    removed_two = client.post(
        f"/api/v1/projects/{project.id}/publications",
        json={"title": "Remove me 2"},
        headers={"X-CSRF-Token": csrf},
    ).json()

    response = client.post(
        f"/api/v1/projects/{project.id}/publications/delete",
        json={"publicationIds": [removed_one["id"], removed_two["id"]]},
        headers={"X-CSRF-Token": csrf},
    )
    assert response.status_code == 200
    assert response.json() == {"deletedCount": 2}

    listing = client.get(f"/api/v1/projects/{project.id}/publications").json()
    assert [publication["id"] for publication in listing] == [kept["id"]]


def test_regular_project_member_can_manage_publications_like_an_owner(
    client, db
) -> None:
    owner = create_user(db, "admin", "Administrator", "secret-password", is_admin=True)
    reviewer = create_user(db, "reviewer", "Reviewer A", "reviewer-password")
    project = Project(
        name="Review", review_type=ReviewType.SYSTEMATIC_REVIEW, random_seed="seed"
    )
    db.add(project)
    db.flush()
    db.add(ProjectMembership(project_id=project.id, user_id=owner.id, is_owner=True))
    db.add(ProjectMembership(project_id=project.id, user_id=reviewer.id))
    publication_one = Publication(
        project_id=project.id, title="Paper one", doi="10.1000/one"
    )
    publication_two = Publication(
        project_id=project.id, title="Paper two", doi="10.1000/two"
    )
    conflict = MetadataConflict(
        publication=publication_one,
        field_name="venue",
        current_value=None,
        proposed_value="Journal of Examples",
        source_name="crossref",
        status="open",
    )
    db.add_all([publication_one, publication_two, conflict])
    db.commit()

    csrf = client.post(
        "/api/v1/auth/login",
        json={"username": "reviewer", "password": "reviewer-password"},
    ).json()["csrfToken"]

    updated = client.patch(
        f"/api/v1/projects/{project.id}/publications/{publication_one.id}",
        json={"title": "Paper one, revised"},
        headers={"X-CSRF-Token": csrf},
    )
    assert updated.status_code == 200
    assert updated.json()["title"] == "Paper one, revised"

    conflicts = client.get(
        f"/api/v1/projects/{project.id}/metadata-conflicts",
        headers={"X-CSRF-Token": csrf},
    )
    assert conflicts.status_code == 200
    resolved = client.post(
        f"/api/v1/projects/{project.id}/metadata-conflicts/{conflict.id}/resolve",
        json={"acceptProposed": True},
        headers={"X-CSRF-Token": csrf},
    )
    assert resolved.status_code == 200

    enriched = client.post(
        f"/api/v1/projects/{project.id}/publications/{publication_one.id}/enrich",
        headers={"X-CSRF-Token": csrf},
    )
    assert enriched.status_code == 202

    bulk_enriched = client.post(
        f"/api/v1/projects/{project.id}/publications/enrich",
        json={"missingOnly": True},
        headers={"X-CSRF-Token": csrf},
    )
    assert bulk_enriched.status_code == 202

    deleted = client.delete(
        f"/api/v1/projects/{project.id}/publications/{publication_two.id}",
        headers={"X-CSRF-Token": csrf},
    )
    assert deleted.status_code == 204

    bulk_deleted = client.post(
        f"/api/v1/projects/{project.id}/publications/delete",
        json={"publicationIds": [publication_one.id]},
        headers={"X-CSRF-Token": csrf},
    )
    assert bulk_deleted.status_code == 200
    assert bulk_deleted.json() == {"deletedCount": 1}


def test_pdfs_can_be_bulk_uploaded_and_auto_matched_without_selecting_publications(
    client, db
) -> None:
    create_user(db, "admin", "Administrator", "secret-password", is_admin=True)
    project = Project(
        name="Review", review_type=ReviewType.SYSTEMATIC_REVIEW, random_seed="seed"
    )
    db.add(project)
    db.commit()
    csrf = login(client)

    matched = client.post(
        f"/api/v1/projects/{project.id}/publications",
        json={"title": "Deep Learning for Urban Planning", "authors": "Doe, Jane"},
        headers={"X-CSRF-Token": csrf},
    ).json()
    unmatched_target = client.post(
        f"/api/v1/projects/{project.id}/publications",
        json={"title": "Wetland Restoration Methods"},
        headers={"X-CSRF-Token": csrf},
    ).json()

    response = client.post(
        f"/api/v1/projects/{project.id}/publications/pdfs",
        files={
            "pdfs": (
                "deep-learning.pdf",
                pdf_bytes("Deep Learning for Urban Planning"),
                "application/pdf",
            )
        },
        headers={"X-CSRF-Token": csrf},
    )
    assert response.status_code == 201
    body = response.json()
    assert body["summary"]["total"] == 1
    assert body["summary"]["matched"] == 1

    publication = client.get(
        f"/api/v1/projects/{project.id}/publications/{matched['id']}"
    ).json()
    assert publication["fullText"]["available"] is True
    untouched = client.get(
        f"/api/v1/projects/{project.id}/publications/{unmatched_target['id']}"
    ).json()
    assert untouched["fullText"]["available"] is False


def test_full_text_exposes_the_retrieval_status_when_a_document_could_not_be_retrieved(
    client, db
) -> None:
    create_user(db, "admin", "Administrator", "secret-password", is_admin=True)
    project = Project(
        name="Review", review_type=ReviewType.SYSTEMATIC_REVIEW, random_seed="seed"
    )
    db.add(project)
    db.commit()
    csrf = login(client)

    publication = client.post(
        f"/api/v1/projects/{project.id}/publications",
        json={"title": "Unreachable Paper"},
        headers={"X-CSRF-Token": csrf},
    ).json()

    db.add(
        FullTextRetrieval(
            project_id=project.id,
            publication_id=publication["id"],
            status=RetrievalStatus.NOT_FOUND,
        )
    )
    db.commit()

    detail = client.get(
        f"/api/v1/projects/{project.id}/publications/{publication['id']}"
    ).json()
    assert detail["fullText"] == {
        "available": False,
        "document": None,
        "retrievalStatus": "not_found",
    }

    listing = client.get(f"/api/v1/projects/{project.id}/publications").json()
    assert listing[0]["fullText"]["retrievalStatus"] == "not_found"


def test_export_bib_returns_a_single_citation_named_by_its_key(client, db) -> None:
    create_user(db, "admin", "Administrator", "secret-password", is_admin=True)
    project = Project(
        name="Review", review_type=ReviewType.SYSTEMATIC_REVIEW, random_seed="seed"
    )
    db.add(project)
    db.commit()
    csrf = login(client)

    publication = client.post(
        f"/api/v1/projects/{project.id}/publications",
        json={
            "title": "Deep Learning for Urban Planning",
            "authors": "Doe, Jane",
            "publicationYear": 2024,
        },
        headers={"X-CSRF-Token": csrf},
    ).json()

    response = client.get(
        f"/api/v1/projects/{project.id}/publications/{publication['id']}/export/bib"
    )
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/x-bibtex")
    assert 'filename="doe2024deep.bib"' in response.headers["content-disposition"]
    assert "@article{doe2024deep," in response.text
    assert "Deep Learning for Urban Planning" in response.text


def test_export_pdf_requires_an_attached_pdf_and_names_it_by_citation_key(
    client, db
) -> None:
    create_user(db, "admin", "Administrator", "secret-password", is_admin=True)
    project = Project(
        name="Review", review_type=ReviewType.SYSTEMATIC_REVIEW, random_seed="seed"
    )
    db.add(project)
    db.commit()
    csrf = login(client)

    publication = client.post(
        f"/api/v1/projects/{project.id}/publications",
        json={
            "title": "Deep Learning for Urban Planning",
            "authors": "Doe, Jane",
            "publicationYear": 2024,
        },
        headers={"X-CSRF-Token": csrf},
    ).json()

    missing = client.get(
        f"/api/v1/projects/{project.id}/publications/{publication['id']}/export/pdf"
    )
    assert missing.status_code == 404

    client.post(
        f"/api/v1/projects/{project.id}/publications/{publication['id']}/full-text",
        files={"file": ("paper.pdf", pdf_bytes("Deep Learning"), "application/pdf")},
        headers={"X-CSRF-Token": csrf},
    )

    response = client.get(
        f"/api/v1/projects/{project.id}/publications/{publication['id']}/export/pdf"
    )
    assert response.status_code == 200
    assert response.headers["content-type"] == "application/pdf"
    assert 'filename="doe2024deep.pdf"' in response.headers["content-disposition"]


def test_a_regular_project_member_can_add_a_publication_manually(client, db) -> None:
    create_user(db, "admin", "Administrator", "secret-password", is_admin=True)
    member = create_user(db, "reviewer", "Reviewer", "secret-password")
    project = Project(
        name="Review", review_type=ReviewType.SYSTEMATIC_REVIEW, random_seed="seed"
    )
    db.add(project)
    db.flush()
    db.add(ProjectMembership(project_id=project.id, user_id=member.id))
    db.commit()

    csrf = client.post(
        "/api/v1/auth/login",
        json={"username": "reviewer", "password": "secret-password"},
    ).json()["csrfToken"]

    response = client.post(
        f"/api/v1/projects/{project.id}/publications",
        json={"title": "Added by a reviewer"},
        headers={"X-CSRF-Token": csrf},
    )

    assert response.status_code == 201
    assert response.json()["title"] == "Added by a reviewer"


def project_and_batch(db):
    admin = create_user(db, "admin", "Administrator", "secret-password", is_admin=True)
    project = Project(
        name="Review", review_type=ReviewType.SYSTEMATIC_REVIEW, random_seed="seed"
    )
    db.add_all([project])
    db.flush()
    batch = ImportBatch(
        project_id=project.id,
        original_filename="records.csv",
        stored_path="/tmp/records.csv",
        file_type="csv",
        status=ImportStatus.COMPLETED,
        created_by_id=admin.id,
    )
    db.add(batch)
    db.flush()
    return admin, project, batch


def test_clean_text_decodes_latex_accents_and_html_entities() -> None:
    assert clean_text(r"K{\"u}chenmeister") == "Küchenmeister"
    assert clean_text(r"J{\"u}rgen") == "Jürgen"
    assert clean_text(r"Jo{\~a}o") == "João"
    assert clean_text(r"Pl{\'a}cido") == "Plácido"
    assert clean_text("PTSD&nbsp;Patients") == "PTSD Patients"
    assert clean_text(r"{COVID-19} outcomes") == "COVID-19 outcomes"
    assert clean_text(r"Stra{\ss}e") == "Straße"
    assert clean_text("a {b c} d") == "a {b c} d"


def test_normalization_creates_publication_and_preserves_source(db) -> None:
    _, project, batch = project_and_batch(db)
    record = ImportedRecord(
        import_batch_id=batch.id,
        source_row=2,
        raw_data={"DOI": "https://doi.org/10.1000/ABC"},
        parsed_data={
            "title": "  A  Paper ",
            "authors": "Doe, Jane",
            "doi": "https://doi.org/10.1000/ABC",
            "year": "2026",
        },
        validation_state="valid",
        warnings=[],
    )
    db.add(record)
    db.commit()

    created = normalize_imported_records(db, batch.id)
    db.commit()

    assert created == 1
    publication = db.scalar(
        select(Publication).where(Publication.project_id == project.id)
    )
    assert publication is not None
    assert publication.title == "A Paper"
    assert publication.doi == "10.1000/abc"
    assert publication.publication_year == 2026
    source = db.scalar(
        select(PublicationSource).where(
            PublicationSource.publication_id == publication.id
        )
    )
    assert source.imported_record_id == record.id


def test_publication_search_sources_trace_back_to_the_import(db) -> None:
    admin, project, batch = project_and_batch(db)
    search = SearchSource(
        project_id=project.id,
        source_name="PubMed",
        query="systematic review",
        search_date=datetime.date(2026, 1, 1),
        created_by_id=admin.id,
    )
    db.add(search)
    db.flush()
    batch.search_source_id = search.id
    record = ImportedRecord(
        import_batch_id=batch.id,
        source_row=1,
        raw_data={"title": "Traceable paper"},
        parsed_data={"title": "Traceable paper"},
        validation_state="valid",
        warnings=[],
    )
    db.add(record)
    db.commit()

    created = normalize_imported_records(db, batch.id)
    db.commit()
    assert created == 1

    publication = db.scalar(
        select(Publication).where(Publication.title == "Traceable paper")
    )
    assert publication.search_sources == [
        {
            "import_batch_id": batch.id,
            "original_filename": "records.csv",
            "search_source_id": search.id,
            "source_name": "PubMed",
        }
    ]


def test_manually_created_publication_has_no_search_sources(db) -> None:
    _, project, _ = project_and_batch(db)
    publication = Publication(project_id=project.id, title="Hand-added paper")
    db.add(publication)
    db.commit()

    assert publication.search_sources == []


def test_enrichment_fills_missing_fields_and_records_important_conflicts(db) -> None:
    _, project, _ = project_and_batch(db)
    publication = Publication(
        project_id=project.id, title="Paper", authors="Doe", publication_year=2025
    )
    db.add(publication)
    db.flush()

    conflicts = apply_enrichment(
        db,
        publication,
        {
            "title": "Paper",
            "abstract": "New abstract",
            "publication_year": 2026,
            "venue": "Journal",
        },
        "crossref",
    )
    db.commit()

    assert publication.abstract == "New abstract"
    assert publication.venue == "Journal"
    assert publication.publication_year == 2025
    assert conflicts == 1
    conflict = db.scalar(
        select(MetadataConflict).where(
            MetadataConflict.publication_id == publication.id
        )
    )
    assert conflict.field_name == "publication_year"
    assert conflict.proposed_value == "2026"


def project_in_title_abstract(db, *, stage=ProjectStage.TITLE_ABSTRACT):
    admin = create_user(db, "admin", "Administrator", "secret-password", is_admin=True)
    reviewer = create_user(db, "reviewer", "Reviewer", "reviewer-password")
    project = Project(
        name="Test",
        review_type=ReviewType.SYSTEMATIC_REVIEW,
        random_seed="seed",
        stage=stage,
    )
    db.add(project)
    db.flush()
    db.add(
        ProjectMembership(
            project_id=project.id, user_id=reviewer.id, can_title_abstract_screen=True
        )
    )
    db.add(
        ScreeningConfig(
            project_id=project.id,
            stage=ScreeningStage.TITLE_ABSTRACT,
            required_reviewers=1,
            allocation_mode=AllocationMode.INDEPENDENT,
        )
    )
    db.commit()
    return admin, reviewer, project


def test_publication_added_manually_after_title_abstract_started_gets_screened(
    client, db
) -> None:
    _, reviewer, project = project_in_title_abstract(db)
    csrf = login(client)

    created = client.post(
        f"/api/v1/projects/{project.id}/publications",
        json={"title": "Late arrival"},
        headers={"X-CSRF-Token": csrf},
    )
    assert created.status_code == 201
    publication_id = created.json()["id"]

    work_item = db.scalar(
        select(ScreeningWorkItem).where(
            ScreeningWorkItem.publication_id == publication_id,
            ScreeningWorkItem.stage == ScreeningStage.TITLE_ABSTRACT,
        )
    )
    assert work_item is not None
    assert work_item.assigned_reviewer_id == reviewer.id


@pytest.mark.parametrize(
    "stage",
    [ProjectStage.FULL_TEXT, ProjectStage.EXTRACTION, ProjectStage.COMPLETED],
)
def test_publication_can_be_added_after_earlier_stages_have_finished(
    client, db, stage
) -> None:
    _, reviewer, project = project_in_title_abstract(db, stage=stage)
    csrf = login(client)

    created = client.post(
        f"/api/v1/projects/{project.id}/publications",
        json={"title": "Added after other stages finished"},
        headers={"X-CSRF-Token": csrf},
    )
    assert created.status_code == 201
    publication_id = created.json()["id"]

    work_item = db.scalar(
        select(ScreeningWorkItem).where(
            ScreeningWorkItem.publication_id == publication_id,
            ScreeningWorkItem.stage == ScreeningStage.TITLE_ABSTRACT,
        )
    )
    assert work_item is not None
    assert work_item.assigned_reviewer_id == reviewer.id
    # Adding the publication must not move other, already-finished
    # publications' project stage backwards.
    db.refresh(project)
    assert project.stage == stage


def test_publication_import_after_title_abstract_started_gets_screened(db) -> None:
    _, reviewer, project = project_in_title_abstract(db)
    batch = ImportBatch(
        project_id=project.id,
        original_filename="records.csv",
        stored_path="/tmp/records.csv",
        file_type="csv",
        status=ImportStatus.COMPLETED,
        created_by_id=reviewer.id,
    )
    db.add(batch)
    db.flush()
    db.add(
        ImportedRecord(
            import_batch_id=batch.id,
            source_row=1,
            raw_data={"title": "Second batch paper"},
            parsed_data={"title": "Second batch paper"},
            validation_state="valid",
            warnings=[],
        )
    )
    db.commit()

    created = normalize_imported_records(db, batch.id)
    db.commit()
    assert created == 1

    publication = db.scalar(
        select(Publication).where(Publication.title == "Second batch paper")
    )
    work_item = db.scalar(
        select(ScreeningWorkItem).where(
            ScreeningWorkItem.publication_id == publication.id,
            ScreeningWorkItem.stage == ScreeningStage.TITLE_ABSTRACT,
        )
    )
    assert work_item is not None
    assert work_item.assigned_reviewer_id == reviewer.id


def test_publication_response_includes_screening_status_per_stage(client, db) -> None:
    admin = create_user(db, "admin", "Administrator", "secret-password", is_admin=True)
    project = Project(
        name="Review", review_type=ReviewType.SYSTEMATIC_REVIEW, random_seed="seed"
    )
    db.add(project)
    db.flush()
    publication = Publication(project_id=project.id, title="Reviewed paper")
    unreviewed = Publication(project_id=project.id, title="Untouched paper")
    db.add_all([publication, unreviewed])
    db.flush()
    criterion = Criterion(
        project_id=project.id,
        kind=CriterionKind.INCLUSION,
        text="Relevant population",
        position=0,
    )
    screening_config = ScreeningConfig(
        project_id=project.id,
        stage=ScreeningStage.TITLE_ABSTRACT,
        required_reviewers=1,
    )
    screening_item = ScreeningWorkItem(
        project_id=project.id,
        publication_id=publication.id,
        stage=ScreeningStage.TITLE_ABSTRACT,
        slot_number=1,
        assigned_reviewer_id=admin.id,
        random_rank="screening-rank",
        status=WorkItemStatus.SUBMITTED,
    )
    db.add_all([criterion, screening_config, screening_item])
    db.flush()
    db.add(
        ScreeningDecision(
            work_item_id=screening_item.id,
            reviewer_id=admin.id,
            outcome=ScreeningOutcome.INCLUDE,
            criteria_answers={criterion.id: True},
            notes="Matches the target population",
            version=1,
            is_current=True,
        )
    )
    db.add(
        ExtractionWorkItem(
            project_id=project.id,
            publication_id=publication.id,
            assigned_reviewer_id=admin.id,
            random_rank="rank",
            status=ExtractionStatus.COMPLETED,
        )
    )
    db.commit()
    csrf = login(client)

    record_final_decision(
        db,
        publication.id,
        ScreeningStage.TITLE_ABSTRACT,
        "include",
        "agreement",
        None,
        None,
    )
    record_final_decision(
        db, publication.id, ScreeningStage.FULL_TEXT, "exclude", "agreement", None, None
    )
    db.commit()

    listing = client.get(f"/api/v1/projects/{project.id}/publications")
    assert listing.status_code == 200
    by_title = {item["title"]: item for item in listing.json()}
    assert by_title["Reviewed paper"]["screeningStatus"] == {
        "titleAbstract": "include",
        "fullText": "exclude",
    }
    assert by_title["Reviewed paper"]["extractionStatus"] == "completed"
    assert by_title["Untouched paper"]["screeningStatus"] == {
        "titleAbstract": None,
        "fullText": None,
    }
    assert by_title["Untouched paper"]["extractionStatus"] is None

    detail = client.get(f"/api/v1/projects/{project.id}/publications/{publication.id}")
    assert detail.json()["screeningStatus"] == {
        "titleAbstract": "include",
        "fullText": "exclude",
    }
    assert detail.json()["extractionStatus"] == "completed"

    review_details = client.get(
        f"/api/v1/projects/{project.id}/publications/{publication.id}/review-details"
    )
    assert review_details.status_code == 200
    final_decision = review_details.json()["screening"]["titleAbstract"][
        "finalDecision"
    ]
    assert final_decision.pop("resolvedAt") is not None
    assert final_decision == {
        "outcome": "include",
        "resolutionMethod": "agreement",
        "note": None,
        "resolvedBy": None,
    }
    assert review_details.json()["screening"]["titleAbstract"]["criteria"] == [
        {
            "id": criterion.id,
            "kind": "inclusion",
            "text": "Relevant population",
        }
    ]
    reviewer_decisions = review_details.json()["screening"]["titleAbstract"][
        "reviewerDecisions"
    ]
    assert reviewer_decisions[0].pop("createdAt") is not None
    assert reviewer_decisions == [
        {
            "workItemId": screening_item.id,
            "reviewerName": "Administrator",
            "outcome": "include",
            "criteriaAnswers": {criterion.id: True},
            "notes": "Matches the target population",
            "version": 1,
        }
    ]

    response_override = client.post(
        f"/api/v1/projects/{project.id}/screening/work-items/{screening_item.id}/override",
        json={
            "outcome": "include",
            "criteriaAnswers": {criterion.id: False},
            "notes": "Owner-corrected criterion response",
            "reason": "The criterion was applied incorrectly",
        },
        headers={"X-CSRF-Token": csrf},
    )
    assert response_override.status_code == 200
    assert response_override.json()["criteriaAnswers"] == {criterion.id: False}
    assert response_override.json()["version"] == 2
    response_audit = db.scalar(
        select(AuditEvent).where(
            AuditEvent.project_id == project.id,
            AuditEvent.action == "screening.criteria_answers_overridden",
        )
    )
    assert response_audit is not None
    assert response_audit.event_metadata["reason"] == (
        "The criterion was applied incorrectly"
    )
    assert response_audit.event_metadata["changedCriteria"] == [
        {
            "criterionId": criterion.id,
            "criterionKind": "inclusion",
            "criterionText": "Relevant population",
            "previousAnswer": True,
            "answer": False,
        }
    ]

    missing_reason = client.post(
        f"/api/v1/projects/{project.id}/screening/title_abstract/publications/{publication.id}/final",
        json={
            "outcome": "exclude",
            "resolutionMethod": "owner_override",
            "note": None,
        },
        headers={"X-CSRF-Token": csrf},
    )
    assert missing_reason.status_code == 400

    override = client.post(
        f"/api/v1/projects/{project.id}/screening/title_abstract/publications/{publication.id}/final",
        json={
            "outcome": "exclude",
            "resolutionMethod": "owner_override",
            "note": "Incorrectly included during screening",
        },
        headers={"X-CSRF-Token": csrf},
    )
    assert override.status_code == 200
    assert override.json()["outcome"] == "exclude"
    audit = db.scalar(
        select(AuditEvent).where(
            AuditEvent.project_id == project.id,
            AuditEvent.action == "screening.decision_overridden",
        )
    )
    assert audit is not None
    assert audit.event_metadata["previousOutcome"] == "include"
    assert audit.event_metadata["outcome"] == "exclude"
    assert audit.event_metadata["reason"] == "Incorrectly included during screening"
