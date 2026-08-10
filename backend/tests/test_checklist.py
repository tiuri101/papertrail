from app.accounts.service import create_user
from app.deduplication.models import DuplicateCandidate
from app.extraction.models import ExtractionWorkItem
from app.forms.models import FormKind
from app.forms.service import create_form
from app.fulltext.models import FullTextRetrieval, RetrievalStatus
from app.jobs.models import BackgroundJob, JobStatus
from app.llm.models import ProjectLlmSettings
from app.projects.checklist import project_checklist
from app.projects.models import (
    Criterion,
    CriterionKind,
    Project,
    ProjectStage,
    ResearchQuestion,
    ReviewType,
)
from app.projects.service import add_membership, get_project
from app.publications.models import Publication
from app.screening.models import ScreeningWorkItem, WorkItemStatus


def login(client) -> str:
    response = client.post(
        "/api/v1/auth/login", json={"username": "admin", "password": "secret-password"}
    )
    return response.json()["csrfToken"]


def test_draft_checklist_reflects_missing_setup_items(db) -> None:
    project = Project(
        name="Review", review_type=ReviewType.SYSTEMATIC_REVIEW, random_seed="seed"
    )
    db.add(project)
    db.commit()

    project = get_project(db, project.id)
    checklist = project_checklist(db, project)

    assert checklist["stage"] == "draft"
    draft = next(
        stage for stage in checklist["stages"] if stage["stage"] == ProjectStage.DRAFT
    )
    assert draft["is_current"] is True
    assert draft["action"] == "ready"
    assert {item["key"]: item["done"] for item in draft["items"]} == {
        "research_questions": False,
        "criteria": False,
        "publications": False,
        "reviewers": False,
    }

    duplicate_review = next(
        stage
        for stage in checklist["stages"]
        if stage["stage"] == ProjectStage.DUPLICATE_REVIEW
    )
    assert duplicate_review["is_current"] is False
    assert duplicate_review["auto_advances"] is True


def test_draft_checklist_completes_as_setup_items_are_added(db) -> None:
    reviewer = create_user(db, "reviewer", "Reviewer", "secret-password")
    project = Project(
        name="Review", review_type=ReviewType.SYSTEMATIC_REVIEW, random_seed="seed"
    )
    db.add(project)
    db.flush()
    db.add(
        ResearchQuestion(project_id=project.id, text="How is X studied?", position=0)
    )
    db.add(
        Criterion(
            project_id=project.id,
            kind=CriterionKind.INCLUSION,
            text="Uses X",
            position=0,
        )
    )
    db.add(
        Criterion(
            project_id=project.id,
            kind=CriterionKind.EXCLUSION,
            text="Not peer reviewed",
            position=1,
        )
    )
    db.add(Publication(project_id=project.id, title="A paper"))
    add_membership(db, project, reviewer, can_title_abstract_screen=True)
    db.commit()

    project = get_project(db, project.id)
    checklist = project_checklist(db, project)
    draft = next(
        stage for stage in checklist["stages"] if stage["stage"] == ProjectStage.DRAFT
    )
    assert {item["key"]: item["done"] for item in draft["items"]} == {
        "research_questions": True,
        "criteria": True,
        "publications": True,
        "reviewers": True,
    }


def test_duplicate_review_checklist_tracks_detection_job_and_resolution(db) -> None:
    admin = create_user(db, "admin", "Administrator", "secret-password", is_admin=True)
    project = Project(
        name="Review",
        review_type=ReviewType.SYSTEMATIC_REVIEW,
        random_seed="seed",
        stage=ProjectStage.DUPLICATE_REVIEW,
    )
    db.add(project)
    db.flush()
    pub_a = Publication(project_id=project.id, title="A Study", doi="10.1/same")
    pub_b = Publication(project_id=project.id, title="A Study", doi="10.1/same")
    db.add_all([pub_a, pub_b])
    db.flush()
    candidate = DuplicateCandidate(
        project_id=project.id,
        publication_a_id=pub_a.id,
        publication_b_id=pub_b.id,
        match_reasons=["exact_doi"],
        confidence=1.0,
    )
    db.add(candidate)
    db.add(
        BackgroundJob(
            project_id=project.id,
            job_type="detect_duplicates",
            status=JobStatus.RUNNING,
            created_by_id=admin.id,
        )
    )
    db.commit()

    project = get_project(db, project.id)
    checklist = project_checklist(db, project)
    stage = next(
        s for s in checklist["stages"] if s["stage"] == ProjectStage.DUPLICATE_REVIEW
    )
    assert stage["is_current"] is True
    items = {item["key"]: item["done"] for item in stage["items"]}
    assert items == {"detection": False, "resolve_duplicates": False}

    job = db.query(BackgroundJob).filter(BackgroundJob.project_id == project.id).one()
    job.status = JobStatus.COMPLETED
    candidate.status = "merged"
    db.commit()

    project = get_project(db, project.id)
    checklist = project_checklist(db, project)
    stage = next(
        s for s in checklist["stages"] if s["stage"] == ProjectStage.DUPLICATE_REVIEW
    )
    items = {item["key"]: item["done"] for item in stage["items"]}
    assert items == {"detection": True, "resolve_duplicates": True}


def test_full_text_checklist_requires_extraction_form_before_extraction(db) -> None:
    project = Project(
        name="Review",
        review_type=ReviewType.SYSTEMATIC_REVIEW,
        random_seed="seed",
        stage=ProjectStage.FULL_TEXT,
    )
    db.add(project)
    db.flush()
    publication = Publication(project_id=project.id, title="A Study")
    db.add(publication)
    db.flush()
    db.add(
        FullTextRetrieval(
            project_id=project.id,
            publication_id=publication.id,
            status=RetrievalStatus.NOT_FOUND,
        )
    )
    db.commit()

    project = get_project(db, project.id)
    checklist = project_checklist(db, project)
    stage = next(s for s in checklist["stages"] if s["stage"] == ProjectStage.FULL_TEXT)
    items = {item["key"]: item["done"] for item in stage["items"]}
    assert items["extraction_form"] is False

    create_form(db, "Extraction form", FormKind.EXTRACTION, project_id=project.id)
    db.commit()

    project = get_project(db, project.id)
    checklist = project_checklist(db, project)
    stage = next(s for s in checklist["stages"] if s["stage"] == ProjectStage.FULL_TEXT)
    items = {item["key"]: item["done"] for item in stage["items"]}
    assert items["extraction_form"] is True


def test_title_abstract_checklist_shows_reviewer_specific_and_overall_open_counts(
    db,
) -> None:
    reviewer_a = create_user(db, "reviewer-a", "Reviewer A", "secret-password")
    reviewer_b = create_user(db, "reviewer-b", "Reviewer B", "secret-password")
    project = Project(
        name="Review",
        review_type=ReviewType.SYSTEMATIC_REVIEW,
        random_seed="seed",
        stage=ProjectStage.TITLE_ABSTRACT,
    )
    db.add(project)
    db.flush()
    pub_a = Publication(project_id=project.id, title="Study A")
    pub_b = Publication(project_id=project.id, title="Study B")
    pub_c = Publication(project_id=project.id, title="Study C")
    db.add_all([pub_a, pub_b, pub_c])
    db.flush()
    db.add_all(
        [
            ScreeningWorkItem(
                project_id=project.id,
                publication_id=pub_a.id,
                stage="title_abstract",
                slot_number=0,
                assigned_reviewer_id=reviewer_a.id,
                random_rank="a",
                status=WorkItemStatus.AVAILABLE,
            ),
            ScreeningWorkItem(
                project_id=project.id,
                publication_id=pub_b.id,
                stage="title_abstract",
                slot_number=0,
                assigned_reviewer_id=reviewer_a.id,
                random_rank="b",
                status=WorkItemStatus.SUBMITTED,
            ),
            ScreeningWorkItem(
                project_id=project.id,
                publication_id=pub_c.id,
                stage="title_abstract",
                slot_number=0,
                assigned_reviewer_id=reviewer_b.id,
                random_rank="c",
                status=WorkItemStatus.AVAILABLE,
            ),
        ]
    )
    db.commit()

    project = get_project(db, project.id)

    checklist_a = project_checklist(db, project, user_id=reviewer_a.id)
    stage_a = next(
        s for s in checklist_a["stages"] if s["stage"] == ProjectStage.TITLE_ABSTRACT
    )
    detail_a = next(
        item for item in stage_a["items"] if item["key"] == "title_abstract_decisions"
    )["detail"]
    assert detail_a == "1 awaiting your decision (3 open in total)"

    checklist_b = project_checklist(db, project, user_id=reviewer_b.id)
    stage_b = next(
        s for s in checklist_b["stages"] if s["stage"] == ProjectStage.TITLE_ABSTRACT
    )
    detail_b = next(
        item for item in stage_b["items"] if item["key"] == "title_abstract_decisions"
    )["detail"]
    assert detail_b == "1 awaiting your decision (3 open in total)"


def test_checklist_endpoint_is_reachable_over_http(client, db) -> None:
    create_user(db, "admin", "Administrator", "secret-password", is_admin=True)
    db.commit()
    csrf = login(client)
    project_id = client.post(
        "/api/v1/projects",
        json={"name": "Review", "reviewType": "systematic_review"},
        headers={"X-CSRF-Token": csrf},
    ).json()["id"]

    response = client.get(f"/api/v1/projects/{project_id}/checklist")
    assert response.status_code == 200
    body = response.json()
    assert body["stage"] == "draft"
    assert [stage["stage"] for stage in body["stages"]] == [
        "draft",
        "duplicate_review",
        "title_abstract_screening",
        "full_text_screening",
        "extraction_quality",
        "completed",
    ]
    draft = body["stages"][0]
    assert draft["action"] == "ready"
    assert draft["items"][0]["key"] == "research_questions"


def test_extraction_checklist_only_shows_llm_validation_when_enabled(db) -> None:
    admin = create_user(
        db, "validation-admin", "Administrator", "secret-password", is_admin=True
    )
    project = Project(
        name="Validation Review",
        review_type=ReviewType.SYSTEMATIC_REVIEW,
        random_seed="seed",
        stage=ProjectStage.EXTRACTION,
    )
    db.add(project)
    db.flush()
    publication = Publication(project_id=project.id, title="A Study")
    db.add(publication)
    db.flush()
    db.add(
        ExtractionWorkItem(
            project_id=project.id,
            publication_id=publication.id,
            assigned_reviewer_id=admin.id,
            random_rank="rank",
        )
    )
    db.commit()

    extraction_stage = next(
        stage
        for stage in project_checklist(db, project)["stages"]
        if stage["stage"] == ProjectStage.EXTRACTION
    )
    assert "llm_extraction_validation" not in {
        item["key"] for item in extraction_stage["items"]
    }

    db.add(
        ProjectLlmSettings(
            project_id=project.id,
            enabled=False,
            extraction_validation_enabled=True,
        )
    )
    db.commit()
    extraction_stage = next(
        stage
        for stage in project_checklist(db, project)["stages"]
        if stage["stage"] == ProjectStage.EXTRACTION
    )
    validation = next(
        item
        for item in extraction_stage["items"]
        if item["key"] == "llm_extraction_validation"
    )
    assert validation["done"] is False
    assert validation["detail"] == "0 of 1 validated"
