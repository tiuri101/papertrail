from app.accounts.service import create_user
from app.deduplication.models import DuplicateCandidate
from app.jobs.models import BackgroundJob, JobStatus
from app.projects.checklist import project_checklist
from app.projects.models import (
    Criterion,
    CriterionKind,
    Project,
    ProjectStage,
    ResearchQuestion,
    ReviewType,
)
from app.projects.service import get_project
from app.publications.models import Publication


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
    }

    duplicate_review = next(
        stage
        for stage in checklist["stages"]
        if stage["stage"] == ProjectStage.DUPLICATE_REVIEW
    )
    assert duplicate_review["is_current"] is False
    assert duplicate_review["auto_advances"] is True


def test_draft_checklist_completes_as_setup_items_are_added(db) -> None:
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
