"""The installation-wide user directory is not readable by everyone.

Audit finding: `GET /users` was open to every authenticated account, handing
any reviewer the username, display name and account state of every user on the
instance. Membership management genuinely needs candidate users, so that
workflow moved to a project-scoped, manager-authorized endpoint that exposes
identity only -- never email, administrator status or password state.
"""

from __future__ import annotations

from app.accounts.service import create_user
from app.projects.models import Project, ProjectMembership, ReviewType

ADMIN_PASSWORD = "admin-password-value"
OWNER_PASSWORD = "owner-password-value"
REVIEWER_PASSWORD = "reviewer-password-value"
OUTSIDER_PASSWORD = "outsider-password-value"


def build_instance(db):
    admin = create_user(db, "root", "Root", ADMIN_PASSWORD, is_admin=True)
    owner = create_user(
        db, "owner", "Owner", OWNER_PASSWORD, email="owner@example.test"
    )
    reviewer = create_user(db, "reviewer", "Reviewer", REVIEWER_PASSWORD)
    outsider = create_user(
        db, "outsider", "Outsider", OUTSIDER_PASSWORD, email="outsider@example.test"
    )
    project = Project(
        name="Review", review_type=ReviewType.SYSTEMATIC_REVIEW, random_seed="seed"
    )
    db.add(project)
    db.flush()
    db.add(
        ProjectMembership(project_id=project.id, user_id=owner.id, is_owner=True)
    )
    db.add(ProjectMembership(project_id=project.id, user_id=reviewer.id))
    db.commit()
    return admin, owner, reviewer, outsider, project


def login(client, username: str, password: str) -> str:
    response = client.post(
        "/api/v1/auth/login", json={"username": username, "password": password}
    )
    assert response.status_code == 200, response.text
    return str(response.json()["csrfToken"])


def test_ordinary_reviewer_cannot_enumerate_installation_users(client, db) -> None:
    _, _, reviewer, _, project = build_instance(db)
    login(client, reviewer.username, REVIEWER_PASSWORD)

    directory = client.get("/api/v1/users")
    assert directory.status_code == 403
    assert directory.json()["error"]["code"] == "forbidden"

    # ... and the project-scoped candidate list is manager-only too, so an
    # ordinary member can't reach the directory sideways through their project.
    candidates = client.get(f"/api/v1/projects/{project.id}/member-candidates")
    assert candidates.status_code == 403


def test_non_member_cannot_read_a_projects_member_candidates(client, db) -> None:
    _, _, _, outsider, project = build_instance(db)
    login(client, outsider.username, OUTSIDER_PASSWORD)

    response = client.get(f"/api/v1/projects/{project.id}/member-candidates")
    assert response.status_code == 403


def test_project_owner_can_list_candidates_without_sensitive_fields(
    client, db
) -> None:
    _, owner, _, outsider, project = build_instance(db)
    login(client, owner.username, OWNER_PASSWORD)

    response = client.get(f"/api/v1/projects/{project.id}/member-candidates")
    assert response.status_code == 200, response.text
    payload = response.json()
    usernames = {entry["username"] for entry in payload}
    assert {"owner", "reviewer", "outsider", "root"} <= usernames
    for entry in payload:
        assert set(entry) == {"id", "username", "displayName", "isActive"}
    assert "outsider@example.test" not in response.text


def test_project_owner_can_still_add_and_manage_members(client, db) -> None:
    _, owner, _, outsider, project = build_instance(db)
    csrf = login(client, owner.username, OWNER_PASSWORD)

    candidates = client.get(f"/api/v1/projects/{project.id}/member-candidates")
    candidate_id = next(
        entry["id"] for entry in candidates.json() if entry["username"] == "outsider"
    )
    assert candidate_id == outsider.id

    added = client.post(
        f"/api/v1/projects/{project.id}/members",
        json={"userId": candidate_id, "canTitleAbstractScreen": True},
        headers={"X-CSRF-Token": csrf},
    )
    assert added.status_code == 201, added.text
    membership_id = added.json()["id"]

    updated = client.patch(
        f"/api/v1/projects/{project.id}/members/{membership_id}",
        json={"canTitleAbstractScreen": False, "canExtract": True},
        headers={"X-CSRF-Token": csrf},
    )
    assert updated.status_code == 200
    assert updated.json()["canExtract"] is True

    removed = client.delete(
        f"/api/v1/projects/{project.id}/members/{membership_id}",
        headers={"X-CSRF-Token": csrf},
    )
    assert removed.status_code == 204


def test_administrator_can_still_read_and_manage_the_directory(client, db) -> None:
    admin, _, reviewer, _, _ = build_instance(db)
    csrf = login(client, admin.username, ADMIN_PASSWORD)

    directory = client.get("/api/v1/users")
    assert directory.status_code == 200
    entries = {entry["username"]: entry for entry in directory.json()}
    assert {"root", "owner", "reviewer", "outsider"} <= set(entries)
    assert entries["owner"]["email"] == "owner@example.test"
    assert entries["root"]["isAdmin"] is True

    deactivated = client.patch(
        f"/api/v1/users/{reviewer.id}",
        json={"isActive": False},
        headers={"X-CSRF-Token": csrf},
    )
    assert deactivated.status_code == 200
    assert deactivated.json()["isActive"] is False
