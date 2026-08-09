from sqlalchemy import select

from app.accounts.models import User
from app.accounts.service import create_user
from app.audit.models import AuditEvent
from app.core.config import get_settings
from app.imports.models import ImportBatch
from app.jobs.models import BackgroundJob, JobStatus
from app.projects.models import (
    AllocationMode,
    Project,
    ProjectMembership,
    ProjectStage,
    ReviewType,
    ScreeningConfig,
    ScreeningStage,
)
from app.publications.models import Publication
from app.screening.models import ScreeningWorkItem
from app.screening.service import create_screening_work_items


def login(client, username: str, password: str) -> str:
    response = client.post(
        "/api/v1/auth/login", json={"username": username, "password": password}
    )
    assert response.status_code == 200
    return response.json()["csrfToken"]


def test_admin_creates_project_and_reviewer_only_sees_memberships(client, db) -> None:
    create_user(db, "admin", "Administrator", "secret-password", is_admin=True)
    reviewer = create_user(db, "reviewer", "Reviewer", "reviewer-password")
    create_user(db, "outsider", "Outsider", "outsider-password")
    db.commit()

    csrf = login(client, "admin", "secret-password")
    created = client.post(
        "/api/v1/projects",
        json={"name": "Urban VR Review", "reviewType": "systematic_review"},
        headers={"X-CSRF-Token": csrf},
    )
    assert created.status_code == 201
    project_id = created.json()["id"]

    membership = client.post(
        f"/api/v1/projects/{project_id}/members",
        json={
            "userId": reviewer.id,
            "canTitleAbstractScreen": True,
            "canFullTextScreen": False,
            "canExtract": True,
            "canAssessQuality": False,
            "canAdjudicate": False,
        },
        headers={"X-CSRF-Token": csrf},
    )
    assert membership.status_code == 201

    client.post("/api/v1/auth/logout", headers={"X-CSRF-Token": csrf})
    login(client, "reviewer", "reviewer-password")
    projects = client.get("/api/v1/projects")
    assert projects.status_code == 200
    assert [project["id"] for project in projects.json()] == [project_id]

    client.cookies.clear()
    login(client, "outsider", "outsider-password")
    assert client.get("/api/v1/projects").json() == []


def test_admin_cannot_add_deactivated_user_as_member(client, db) -> None:
    create_user(db, "admin", "Administrator", "secret-password", is_admin=True)
    reviewer = create_user(db, "reviewer", "Reviewer", "reviewer-password")
    reviewer.is_active = False
    db.commit()

    csrf = login(client, "admin", "secret-password")
    created = client.post(
        "/api/v1/projects",
        json={"name": "Urban VR Review", "reviewType": "systematic_review"},
        headers={"X-CSRF-Token": csrf},
    )
    project_id = created.json()["id"]

    membership = client.post(
        f"/api/v1/projects/{project_id}/members",
        json={
            "userId": reviewer.id,
            "canTitleAbstractScreen": True,
            "canFullTextScreen": False,
            "canExtract": False,
            "canAssessQuality": False,
            "canAdjudicate": False,
        },
        headers={"X-CSRF-Token": csrf},
    )
    assert membership.status_code == 409


def test_admin_updates_and_removes_project_membership(client, db) -> None:
    create_user(db, "admin", "Administrator", "secret-password", is_admin=True)
    reviewer = create_user(db, "reviewer", "Reviewer", "reviewer-password")
    db.commit()

    csrf = login(client, "admin", "secret-password")
    created = client.post(
        "/api/v1/projects",
        json={"name": "Urban VR Review", "reviewType": "systematic_review"},
        headers={"X-CSRF-Token": csrf},
    )
    project_id = created.json()["id"]

    membership = client.post(
        f"/api/v1/projects/{project_id}/members",
        json={
            "userId": reviewer.id,
            "canTitleAbstractScreen": True,
            "canFullTextScreen": False,
            "canExtract": False,
            "canAssessQuality": False,
            "canAdjudicate": False,
        },
        headers={"X-CSRF-Token": csrf},
    )
    member_id = membership.json()["id"]

    updated = client.patch(
        f"/api/v1/projects/{project_id}/members/{member_id}",
        json={
            "canTitleAbstractScreen": True,
            "canFullTextScreen": True,
            "canExtract": False,
            "canAssessQuality": False,
            "canAdjudicate": False,
        },
        headers={"X-CSRF-Token": csrf},
    )
    assert updated.status_code == 200
    assert updated.json()["canFullTextScreen"] is True

    removed = client.delete(
        f"/api/v1/projects/{project_id}/members/{member_id}",
        headers={"X-CSRF-Token": csrf},
    )
    assert removed.status_code == 204

    detail = client.get(f"/api/v1/projects/{project_id}")
    # The creator's own owner membership stays behind; only the removed
    # reviewer is gone.
    memberships = detail.json()["memberships"]
    assert len(memberships) == 1
    assert memberships[0]["isOwner"] is True


def test_adding_a_reviewer_mid_stage_rebalances_the_backlog_onto_them(
    client, db
) -> None:
    admin = create_user(db, "admin", "Administrator", "secret-password", is_admin=True)
    reviewer1 = create_user(db, "reviewer1", "Reviewer 1", "password-1")
    reviewer2 = create_user(db, "reviewer2", "Reviewer 2", "password-2")
    project = Project(
        name="Test",
        review_type=ReviewType.SYSTEMATIC_REVIEW,
        random_seed="seed",
        stage=ProjectStage.TITLE_ABSTRACT,
    )
    db.add(project)
    db.flush()
    db.add_all(
        [
            ProjectMembership(project_id=project.id, user_id=admin.id, is_owner=True),
            ProjectMembership(
                project_id=project.id,
                user_id=reviewer1.id,
                can_title_abstract_screen=True,
            ),
        ]
    )
    db.add(
        ScreeningConfig(
            project_id=project.id,
            stage=ScreeningStage.TITLE_ABSTRACT,
            required_reviewers=1,
            allocation_mode=AllocationMode.INDEPENDENT,
        )
    )
    publications = [
        Publication(project_id=project.id, title=f"Paper {i}") for i in range(4)
    ]
    db.add_all(publications)
    db.commit()
    create_screening_work_items(db, project, ScreeningStage.TITLE_ABSTRACT)
    db.commit()

    def counts() -> dict[str, int]:
        tally: dict[str, int] = {}
        for item in db.scalars(
            select(ScreeningWorkItem).where(ScreeningWorkItem.project_id == project.id)
        ):
            tally[item.assigned_reviewer_id] = (
                tally.get(item.assigned_reviewer_id, 0) + 1
            )
        return tally

    assert counts() == {reviewer1.id: 4}

    csrf = login(client, "admin", "secret-password")
    response = client.post(
        f"/api/v1/projects/{project.id}/members",
        json={
            "userId": reviewer2.id,
            "canTitleAbstractScreen": True,
            "canFullTextScreen": False,
            "canExtract": False,
            "canAssessQuality": False,
            "canAdjudicate": False,
        },
        headers={"X-CSRF-Token": csrf},
    )
    assert response.status_code == 201

    db.expire_all()
    assert counts() == {reviewer1.id: 2, reviewer2.id: 2}


def test_project_configuration_supports_questions_criteria_and_stage_settings(
    client, db
) -> None:
    create_user(db, "admin", "Administrator", "secret-password", is_admin=True)
    db.commit()
    csrf = login(client, "admin", "secret-password")
    project = client.post(
        "/api/v1/projects",
        json={"name": "Review", "reviewType": "scoping_review"},
        headers={"X-CSRF-Token": csrf},
    ).json()
    project_id = project["id"]

    rq = client.post(
        f"/api/v1/projects/{project_id}/research-questions",
        json={"text": "How is urban data visualized?"},
        headers={"X-CSRF-Token": csrf},
    )
    assert rq.status_code == 201

    inclusion = client.post(
        f"/api/v1/projects/{project_id}/criteria",
        json={"kind": "inclusion", "text": "Uses virtual reality"},
        headers={"X-CSRF-Token": csrf},
    )
    assert inclusion.status_code == 201

    config = client.put(
        f"/api/v1/projects/{project_id}/screening-config/title_abstract",
        json={
            "requiredReviewers": 2,
            "allocationMode": "independent",
            "conflictResolution": "admin_consensus",
            "uncertainResolution": "admin_consensus",
        },
        headers={"X-CSRF-Token": csrf},
    )
    assert config.status_code == 200
    assert config.json()["requiredReviewers"] == 2

    details = client.get(f"/api/v1/projects/{project_id}")
    assert details.status_code == 200
    assert (
        details.json()["researchQuestions"][0]["text"]
        == "How is urban data visualized?"
    )
    assert details.json()["criteria"][0]["kind"] == "inclusion"


def test_research_questions_and_criteria_support_edit_and_delete(client, db) -> None:
    create_user(db, "admin", "Administrator", "secret-password", is_admin=True)
    db.commit()
    csrf = login(client, "admin", "secret-password")
    project_id = client.post(
        "/api/v1/projects",
        json={"name": "Review", "reviewType": "scoping_review"},
        headers={"X-CSRF-Token": csrf},
    ).json()["id"]

    rq_id = client.post(
        f"/api/v1/projects/{project_id}/research-questions",
        json={"text": "Original question"},
        headers={"X-CSRF-Token": csrf},
    ).json()["id"]
    criterion_id = client.post(
        f"/api/v1/projects/{project_id}/criteria",
        json={"kind": "inclusion", "text": "Original criterion"},
        headers={"X-CSRF-Token": csrf},
    ).json()["id"]

    updated_rq = client.patch(
        f"/api/v1/projects/{project_id}/research-questions/{rq_id}",
        json={"text": "Revised question"},
        headers={"X-CSRF-Token": csrf},
    )
    assert updated_rq.status_code == 200
    assert updated_rq.json()["text"] == "Revised question"

    updated_criterion = client.patch(
        f"/api/v1/projects/{project_id}/criteria/{criterion_id}",
        json={"kind": "exclusion", "text": "Revised criterion"},
        headers={"X-CSRF-Token": csrf},
    )
    assert updated_criterion.status_code == 200
    assert updated_criterion.json()["kind"] == "exclusion"

    details = client.get(f"/api/v1/projects/{project_id}").json()
    assert details["researchQuestions"][0]["text"] == "Revised question"
    assert details["criteria"][0]["kind"] == "exclusion"

    assert (
        client.delete(
            f"/api/v1/projects/{project_id}/research-questions/{rq_id}",
            headers={"X-CSRF-Token": csrf},
        ).status_code
        == 204
    )
    assert (
        client.delete(
            f"/api/v1/projects/{project_id}/criteria/{criterion_id}",
            headers={"X-CSRF-Token": csrf},
        ).status_code
        == 204
    )

    details_after_delete = client.get(f"/api/v1/projects/{project_id}").json()
    assert details_after_delete["researchQuestions"] == []
    assert details_after_delete["criteria"] == []


def test_admin_renames_project_and_updates_description(client, db) -> None:
    create_user(db, "admin", "Administrator", "secret-password", is_admin=True)
    reviewer = create_user(db, "reviewer", "Reviewer", "reviewer-password")
    db.commit()
    csrf = login(client, "admin", "secret-password")
    project_id = client.post(
        "/api/v1/projects",
        json={"name": "Original Name", "reviewType": "scoping_review"},
        headers={"X-CSRF-Token": csrf},
    ).json()["id"]
    client.post(
        f"/api/v1/projects/{project_id}/members",
        json={
            "userId": reviewer.id,
            "canTitleAbstractScreen": True,
            "canFullTextScreen": False,
            "canExtract": False,
            "canAssessQuality": False,
            "canAdjudicate": False,
        },
        headers={"X-CSRF-Token": csrf},
    )

    renamed = client.patch(
        f"/api/v1/projects/{project_id}",
        json={"name": "Renamed Review", "description": "Updated description"},
        headers={"X-CSRF-Token": csrf},
    )
    assert renamed.status_code == 200
    assert renamed.json()["name"] == "Renamed Review"
    assert renamed.json()["description"] == "Updated description"

    details = client.get(f"/api/v1/projects/{project_id}").json()
    assert details["name"] == "Renamed Review"
    assert details["description"] == "Updated description"

    client.cookies.clear()
    login(client, "reviewer", "reviewer-password")
    forbidden = client.patch(
        f"/api/v1/projects/{project_id}",
        json={"name": "Should not work"},
        headers={"X-CSRF-Token": csrf},
    )
    assert forbidden.status_code in (401, 403)


def test_reset_project_clears_publications_but_keeps_configuration(client, db) -> None:
    create_user(db, "admin", "Administrator", "secret-password", is_admin=True)
    db.commit()
    csrf = login(client, "admin", "secret-password")
    project_id = client.post(
        "/api/v1/projects",
        json={"name": "Review", "reviewType": "scoping_review"},
        headers={"X-CSRF-Token": csrf},
    ).json()["id"]
    client.post(
        f"/api/v1/projects/{project_id}/research-questions",
        json={"text": "How is urban data visualized?"},
        headers={"X-CSRF-Token": csrf},
    )
    client.post(
        f"/api/v1/projects/{project_id}/publications",
        json={"title": "Some paper"},
        headers={"X-CSRF-Token": csrf},
    )

    reset = client.post(
        f"/api/v1/projects/{project_id}/reset", headers={"X-CSRF-Token": csrf}
    )
    assert reset.status_code == 200
    assert reset.json()["stage"] == "draft"

    details = client.get(f"/api/v1/projects/{project_id}").json()
    assert len(details["researchQuestions"]) == 1

    publications = client.get(f"/api/v1/projects/{project_id}/publications")
    assert publications.json() == []


def test_admin_sets_highlight_keywords_and_reviewer_can_read_them(client, db) -> None:
    create_user(db, "admin", "Administrator", "secret-password", is_admin=True)
    reviewer = create_user(db, "reviewer", "Reviewer", "reviewer-password")
    db.commit()
    csrf = login(client, "admin", "secret-password")
    project_id = client.post(
        "/api/v1/projects",
        json={"name": "Review", "reviewType": "scoping_review"},
        headers={"X-CSRF-Token": csrf},
    ).json()["id"]
    client.post(
        f"/api/v1/projects/{project_id}/members",
        json={
            "userId": reviewer.id,
            "canTitleAbstractScreen": True,
            "canFullTextScreen": False,
            "canExtract": False,
            "canAssessQuality": False,
            "canAdjudicate": False,
        },
        headers={"X-CSRF-Token": csrf},
    )

    empty = client.get(f"/api/v1/projects/{project_id}/highlight-keywords")
    assert empty.status_code == 200
    assert empty.json()["keywords"] == []

    updated = client.put(
        f"/api/v1/projects/{project_id}/highlight-keywords",
        json={
            "keywords": ["virtual reality", " virtual reality ", "urban analytics", ""]
        },
        headers={"X-CSRF-Token": csrf},
    )
    assert updated.status_code == 200
    assert updated.json()["keywords"] == ["virtual reality", "urban analytics"]

    client.post("/api/v1/auth/logout", headers={"X-CSRF-Token": csrf})
    login(client, "reviewer", "reviewer-password")
    as_reviewer = client.get(f"/api/v1/projects/{project_id}/highlight-keywords")
    assert as_reviewer.status_code == 200
    assert as_reviewer.json()["keywords"] == ["virtual reality", "urban analytics"]

    forbidden = client.put(
        f"/api/v1/projects/{project_id}/highlight-keywords",
        json={"keywords": ["nope"]},
    )
    assert forbidden.status_code == 403


def test_owner_sets_prompt_instructions_and_they_reach_the_llm_messages(
    client, db
) -> None:
    from app.llm.prompt import SYSTEM_PROMPT, extraction_messages
    from app.llm.task_prompt import SCREENING_SYSTEM_PROMPT, VALIDATION_SYSTEM_PROMPT

    create_user(db, "admin", "Administrator", "secret-password", is_admin=True)
    reviewer = create_user(db, "reviewer", "Reviewer", "reviewer-password")
    db.commit()
    csrf = login(client, "admin", "secret-password")
    project_id = client.post(
        "/api/v1/projects",
        json={"name": "Review", "reviewType": "scoping_review"},
        headers={"X-CSRF-Token": csrf},
    ).json()["id"]
    client.post(
        f"/api/v1/projects/{project_id}/members",
        json={
            "userId": reviewer.id,
            "canTitleAbstractScreen": True,
            "canFullTextScreen": False,
            "canExtract": False,
            "canAssessQuality": False,
            "canAdjudicate": False,
        },
        headers={"X-CSRF-Token": csrf},
    )

    initial = client.get(
        f"/api/v1/projects/{project_id}/prompt-settings",
        headers={"X-CSRF-Token": csrf},
    )
    assert initial.status_code == 200
    flows = {item["key"]: item for item in initial.json()["flows"]}
    assert flows["extraction"]["basePrompt"] == SYSTEM_PROMPT
    assert flows["extraction"]["customInstructions"] == ""
    assert flows["titleAbstract"]["basePrompt"] == SCREENING_SYSTEM_PROMPT
    assert flows["validation"]["basePrompt"] == VALIDATION_SYSTEM_PROMPT

    updated = client.put(
        f"/api/v1/projects/{project_id}/prompt-settings",
        json={
            "extractionInstructions": "Treat 'RQ' as shorthand for research question.",
            "titleAbstractInstructions": "This review only covers robotics venues.",
            "fullTextInstructions": "",
            "validationInstructions": "",
        },
        headers={"X-CSRF-Token": csrf},
    )
    assert updated.status_code == 200
    updated_flows = {item["key"]: item for item in updated.json()["flows"]}
    assert updated_flows["extraction"]["customInstructions"] == (
        "Treat 'RQ' as shorthand for research question."
    )

    project = db.get(Project, project_id)
    assert project.extraction_prompt_instructions == (
        "Treat 'RQ' as shorthand for research question."
    )
    assert project.title_abstract_prompt_instructions == (
        "This review only covers robotics venues."
    )

    messages = extraction_messages(
        [], "paper text", project.extraction_prompt_instructions
    )
    system_message = messages[0]["content"]
    assert SYSTEM_PROMPT in system_message
    assert "Treat 'RQ' as shorthand for research question." in system_message
    assert system_message.index(SYSTEM_PROMPT) < system_message.index("Treat 'RQ'")

    plain = extraction_messages([], "paper text")
    assert plain[0]["content"] == SYSTEM_PROMPT

    client.cookies.clear()
    reviewer_csrf = login(client, "reviewer", "reviewer-password")
    forbidden_get = client.get(
        f"/api/v1/projects/{project_id}/prompt-settings",
        headers={"X-CSRF-Token": reviewer_csrf},
    )
    assert forbidden_get.status_code == 403
    forbidden_put = client.put(
        f"/api/v1/projects/{project_id}/prompt-settings",
        json={
            "extractionInstructions": "nope",
            "titleAbstractInstructions": "",
            "fullTextInstructions": "",
            "validationInstructions": "",
        },
        headers={"X-CSRF-Token": reviewer_csrf},
    )
    assert forbidden_put.status_code == 403


def test_delete_project_removes_it_entirely(client, db, tmp_path, monkeypatch) -> None:
    settings = get_settings()
    monkeypatch.setattr(settings, "pdf_storage_path", tmp_path / "pdfs")
    monkeypatch.setattr(settings, "import_dir", tmp_path / "imports")
    monkeypatch.setattr(settings, "export_dir", tmp_path / "exports")
    settings.ensure_directories()
    create_user(db, "admin", "Administrator", "secret-password", is_admin=True)
    db.commit()
    csrf = login(client, "admin", "secret-password")
    project_id = client.post(
        "/api/v1/projects",
        json={"name": "Disposable Review", "reviewType": "scoping_review"},
        headers={"X-CSRF-Token": csrf},
    ).json()["id"]
    publication = client.post(
        f"/api/v1/projects/{project_id}/publications",
        json={"title": "Some paper"},
        headers={"X-CSRF-Token": csrf},
    ).json()

    admin = db.scalar(select(User).where(User.username == "admin"))
    assert admin is not None
    import_directory = settings.import_dir / project_id
    import_directory.mkdir(parents=True)
    import_file = import_directory / "source.ris"
    import_file.write_text("TY  - JOUR", encoding="utf-8")
    batch = ImportBatch(
        project_id=project_id,
        original_filename="source.ris",
        stored_path=str(import_file),
        file_type="ris",
        created_by_id=admin.id,
    )
    db.add(batch)
    db.commit()

    pdf_directory = (
        settings.pdf_storage_path
        / "projects"
        / project_id
        / "publications"
        / publication["id"]
    )
    pdf_directory.mkdir(parents=True)
    (pdf_directory / "paper.pdf").write_bytes(b"project PDF")
    staging_directory = settings.pdf_storage_path / "staging" / "imports" / batch.id
    staging_directory.mkdir(parents=True)
    (staging_directory / "unmatched.pdf").write_bytes(b"staged PDF")
    export_directory = settings.export_dir / project_id
    export_directory.mkdir(parents=True)
    (export_directory / "results.xlsx").write_bytes(b"export")
    unrelated_directory = settings.pdf_storage_path / "projects" / "another-project"
    unrelated_directory.mkdir(parents=True)
    unrelated_file = unrelated_directory / "keep.pdf"
    unrelated_file.write_bytes(b"keep")

    deleted = client.delete(
        f"/api/v1/projects/{project_id}", headers={"X-CSRF-Token": csrf}
    )
    assert deleted.status_code == 204

    assert client.get(f"/api/v1/projects/{project_id}").status_code == 404
    assert [p["id"] for p in client.get("/api/v1/projects").json()] == []
    assert not (settings.pdf_storage_path / "projects" / project_id).exists()
    assert not staging_directory.exists()
    assert not import_directory.exists()
    assert not export_directory.exists()
    assert unrelated_file.read_bytes() == b"keep"

    db.expire_all()
    retained_events = list(db.scalars(select(AuditEvent)))
    assert all(event.project_id != project_id for event in retained_events)
    assert all(event.entity_id != project_id for event in retained_events)
    assert all("Disposable Review" not in event.summary for event in retained_events)


def test_delete_project_waits_for_running_jobs(client, db) -> None:
    create_user(db, "admin", "Administrator", "secret-password", is_admin=True)
    db.commit()
    csrf = login(client, "admin", "secret-password")
    project_id = client.post(
        "/api/v1/projects",
        json={"name": "Busy Review", "reviewType": "scoping_review"},
        headers={"X-CSRF-Token": csrf},
    ).json()["id"]
    db.add(
        BackgroundJob(
            project_id=project_id,
            job_type="generate_export",
            payload={},
            status=JobStatus.RUNNING,
        )
    )
    db.commit()

    response = client.delete(
        f"/api/v1/projects/{project_id}", headers={"X-CSRF-Token": csrf}
    )

    assert response.status_code == 409
    assert response.json()["error"]["message"] == (
        "Wait for running background jobs to finish before deleting the project"
    )
    assert client.get(f"/api/v1/projects/{project_id}").status_code == 200
