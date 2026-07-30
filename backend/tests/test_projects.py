from app.accounts.service import create_user


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

    reason = client.post(
        f"/api/v1/projects/{project_id}/exclusion-reasons/title_abstract",
        json={"label": "Wrong context"},
        headers={"X-CSRF-Token": csrf},
    )
    assert reason.status_code == 201

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


def test_delete_project_removes_it_entirely(client, db) -> None:
    create_user(db, "admin", "Administrator", "secret-password", is_admin=True)
    db.commit()
    csrf = login(client, "admin", "secret-password")
    project_id = client.post(
        "/api/v1/projects",
        json={"name": "Disposable Review", "reviewType": "scoping_review"},
        headers={"X-CSRF-Token": csrf},
    ).json()["id"]
    client.post(
        f"/api/v1/projects/{project_id}/publications",
        json={"title": "Some paper"},
        headers={"X-CSRF-Token": csrf},
    )

    deleted = client.delete(
        f"/api/v1/projects/{project_id}", headers={"X-CSRF-Token": csrf}
    )
    assert deleted.status_code == 204

    assert client.get(f"/api/v1/projects/{project_id}").status_code == 404
    assert [p["id"] for p in client.get("/api/v1/projects").json()] == []
