from app.accounts.service import create_user
from app.deduplication.models import DuplicateCandidate
from app.extraction.models import (
    ExtractionConfig,
    ExtractionStatus,
    ExtractionWorkItem,
)
from app.forms.models import FormKind
from app.forms.service import create_form
from app.fulltext.models import FullTextRetrieval, RetrievalStatus
from app.jobs.models import BackgroundJob, JobStatus
from app.llm.models import ProjectLlmSettings
from app.projects.checklist import project_checklist
from app.projects.models import (
    AllocationMode,
    Criterion,
    CriterionKind,
    Project,
    ProjectStage,
    ResearchQuestion,
    ReviewType,
    ScreeningConfig,
    ScreeningStage,
    TaskAllocationMode,
)
from app.projects.service import add_membership, get_project
from app.publications.models import Publication
from app.quality.models import QualityConfig, QualityStatus, QualityWorkItem
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


def test_checklist_builds_items_only_for_the_current_stage(db) -> None:
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

    by_stage = {stage["stage"]: stage for stage in checklist["stages"]}
    assert by_stage[ProjectStage.FULL_TEXT]["is_current"] is True
    assert by_stage[ProjectStage.FULL_TEXT]["items"] != []
    # Every other stage (past or future) carries no computed items -- only
    # the current stage's list is ever rendered.
    for stage_value, stage in by_stage.items():
        if stage_value != ProjectStage.FULL_TEXT:
            assert stage["items"] == []
    assert by_stage[ProjectStage.DRAFT]["is_complete"] is True
    assert by_stage[ProjectStage.EXTRACTION]["is_complete"] is False


def test_title_abstract_open_count_excludes_finalized_publications(db) -> None:
    from app.conflicts.service import record_final_decision
    from app.projects.models import ScreeningStage

    project = Project(
        name="Review",
        review_type=ReviewType.SYSTEMATIC_REVIEW,
        random_seed="seed",
        stage=ProjectStage.TITLE_ABSTRACT,
    )
    db.add(project)
    db.flush()
    decided = Publication(project_id=project.id, title="Decided")
    pending = Publication(project_id=project.id, title="Pending")
    db.add_all([decided, pending])
    db.flush()
    record_final_decision(
        db, decided.id, ScreeningStage.TITLE_ABSTRACT, "include", "agreement", None, None
    )
    db.commit()

    project = get_project(db, project.id)
    stage = next(
        s
        for s in project_checklist(db, project)["stages"]
        if s["stage"] == ProjectStage.TITLE_ABSTRACT
    )
    item = next(i for i in stage["items"] if i["key"] == "title_abstract_decisions")
    assert item["done"] is False
    assert item["detail"] == "0 awaiting your decision (1 open in total)"


def test_full_text_decisions_counts_finalized_available_publications(db) -> None:
    from app.conflicts.service import record_final_decision
    from app.projects.models import ScreeningStage

    project = Project(
        name="Review",
        review_type=ReviewType.SYSTEMATIC_REVIEW,
        random_seed="seed",
        stage=ProjectStage.FULL_TEXT,
    )
    db.add(project)
    db.flush()
    pub_a = Publication(project_id=project.id, title="Study A")
    pub_b = Publication(project_id=project.id, title="Study B")
    db.add_all([pub_a, pub_b])
    db.flush()
    db.add_all(
        [
            FullTextRetrieval(
                project_id=project.id,
                publication_id=pub_a.id,
                status=RetrievalStatus.AVAILABLE,
            ),
            FullTextRetrieval(
                project_id=project.id,
                publication_id=pub_b.id,
                status=RetrievalStatus.AVAILABLE,
            ),
        ]
    )
    record_final_decision(
        db, pub_a.id, ScreeningStage.FULL_TEXT, "include", "agreement", None, None
    )
    db.commit()

    project = get_project(db, project.id)

    def full_text_decisions() -> dict:
        stage = next(
            s
            for s in project_checklist(db, project)["stages"]
            if s["stage"] == ProjectStage.FULL_TEXT
        )
        return next(i for i in stage["items"] if i["key"] == "full_text_decisions")

    item = full_text_decisions()
    assert item["done"] is False
    assert item["detail"] == "0 awaiting your decision (1 open in total)"

    record_final_decision(
        db, pub_b.id, ScreeningStage.FULL_TEXT, "exclude", "agreement", None, None
    )
    db.commit()
    project = get_project(db, project.id)
    assert full_text_decisions()["done"] is True


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
    from app.conflicts.service import record_final_decision
    from app.projects.models import ScreeningStage

    record_final_decision(
        db, publication.id, ScreeningStage.FULL_TEXT, "include", "agreement", None, None
    )
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


def _screening_item(checklist: dict, stage: ProjectStage, key: str) -> dict:
    stage_block = next(s for s in checklist["stages"] if s["stage"] == stage)
    return next(item for item in stage_block["items"] if item["key"] == key)


def test_title_abstract_claim_mode_reports_the_claimable_pool(db) -> None:
    reviewer = create_user(db, "claim-reviewer", "Claim Reviewer", "secret-password")
    project = Project(
        name="Review",
        review_type=ReviewType.SYSTEMATIC_REVIEW,
        random_seed="seed",
        stage=ProjectStage.TITLE_ABSTRACT,
    )
    db.add(project)
    db.flush()
    db.add(
        ScreeningConfig(
            project_id=project.id,
            stage=ScreeningStage.TITLE_ABSTRACT,
            allocation_mode=AllocationMode.CLAIM,
        )
    )
    pubs = [Publication(project_id=project.id, title=f"Study {n}") for n in range(3)]
    db.add_all(pubs)
    db.flush()
    # Claim-mode work items sit unassigned in a shared pool until a reviewer
    # picks one up -- the reviewer here has claimed nothing yet.
    db.add_all(
        ScreeningWorkItem(
            project_id=project.id,
            publication_id=pub.id,
            stage="title_abstract",
            slot_number=0,
            assigned_reviewer_id=None,
            random_rank=str(index),
            status=WorkItemStatus.AVAILABLE,
        )
        for index, pub in enumerate(pubs)
    )
    db.commit()

    project = get_project(db, project.id)
    item = _screening_item(
        project_checklist(db, project, user_id=reviewer.id),
        ProjectStage.TITLE_ABSTRACT,
        "title_abstract_decisions",
    )
    assert item["done"] is False
    assert item["detail"] == "3 available for you to screen (3 open in total)"


def test_title_abstract_claim_mode_when_nothing_is_claimable(db) -> None:
    reviewer_a = create_user(db, "claim-a", "Claim A", "secret-password")
    reviewer_b = create_user(db, "claim-b", "Claim B", "secret-password")
    project = Project(
        name="Review",
        review_type=ReviewType.SYSTEMATIC_REVIEW,
        random_seed="seed",
        stage=ProjectStage.TITLE_ABSTRACT,
    )
    db.add(project)
    db.flush()
    db.add(
        ScreeningConfig(
            project_id=project.id,
            stage=ScreeningStage.TITLE_ABSTRACT,
            allocation_mode=AllocationMode.CLAIM,
        )
    )
    pub = Publication(project_id=project.id, title="Study")
    db.add(pub)
    db.flush()
    # The only slot is already submitted by the other reviewer, but the
    # publication has no final decision yet, so it is still "open in total".
    db.add(
        ScreeningWorkItem(
            project_id=project.id,
            publication_id=pub.id,
            stage="title_abstract",
            slot_number=0,
            assigned_reviewer_id=reviewer_b.id,
            random_rank="a",
            status=WorkItemStatus.SUBMITTED,
        )
    )
    db.commit()

    project = get_project(db, project.id)
    item = _screening_item(
        project_checklist(db, project, user_id=reviewer_a.id),
        ProjectStage.TITLE_ABSTRACT,
        "title_abstract_decisions",
    )
    assert item["detail"] == "Nothing for you to claim right now (1 open in total)"


def test_extraction_claim_mode_reports_the_claimable_pool(db) -> None:
    from app.conflicts.service import record_final_decision

    reviewer = create_user(db, "extract-claim", "Extractor", "secret-password")
    project = Project(
        name="Review",
        review_type=ReviewType.SYSTEMATIC_REVIEW,
        random_seed="seed",
        stage=ProjectStage.EXTRACTION,
    )
    db.add(project)
    db.flush()
    pub = Publication(project_id=project.id, title="A Study")
    db.add(pub)
    db.flush()
    record_final_decision(
        db, pub.id, ScreeningStage.FULL_TEXT, "include", "agreement", None, None
    )
    db.add(
        ExtractionConfig(
            project_id=project.id, allocation_mode=TaskAllocationMode.CLAIM
        )
    )
    db.add(
        ExtractionWorkItem(
            project_id=project.id,
            publication_id=pub.id,
            slot_number=1,
            assigned_reviewer_id=None,
            random_rank="r",
            status=ExtractionStatus.AVAILABLE,
        )
    )
    db.commit()

    project = get_project(db, project.id)
    item = _screening_item(
        project_checklist(db, project, user_id=reviewer.id),
        ProjectStage.EXTRACTION,
        "extraction",
    )
    assert item["done"] is False
    assert item["detail"] == "1 available for you to extract (1 open in total)"


def test_quality_claim_mode_reports_the_claimable_pool(db) -> None:
    from app.conflicts.service import record_final_decision

    reviewer = create_user(db, "quality-claim", "Assessor", "secret-password")
    project = Project(
        name="Review",
        review_type=ReviewType.SYSTEMATIC_REVIEW,
        random_seed="seed",
        stage=ProjectStage.EXTRACTION,
    )
    db.add(project)
    db.flush()
    pub = Publication(project_id=project.id, title="A Study")
    db.add(pub)
    db.flush()
    record_final_decision(
        db, pub.id, ScreeningStage.FULL_TEXT, "include", "agreement", None, None
    )
    db.add(
        QualityConfig(
            project_id=project.id,
            enabled=True,
            allocation_mode=TaskAllocationMode.CLAIM,
        )
    )
    db.add(
        QualityWorkItem(
            project_id=project.id,
            publication_id=pub.id,
            assigned_reviewer_id=None,
            random_rank="r",
            status=QualityStatus.AVAILABLE,
        )
    )
    db.commit()

    project = get_project(db, project.id)
    item = _screening_item(
        project_checklist(db, project, user_id=reviewer.id),
        ProjectStage.EXTRACTION,
        "quality",
    )
    assert item["done"] is False
    assert item["detail"] == "1 available for you to assess (1 open in total)"
