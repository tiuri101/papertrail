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
