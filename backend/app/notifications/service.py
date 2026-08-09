from __future__ import annotations

import hashlib
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.accounts.models import User
from app.core.config import get_settings
from app.jobs.models import BackgroundJob, JobStatus
from app.jobs.service import enqueue_job
from app.llm.models import LlmExtractionRun, LlmTaskType, ProcessingStatus
from app.notifications.mailer import send_smtp_email
from app.notifications.models import EmailDeliveryStatus, EmailNotification
from app.notifications.templates import render_email
from app.projects.models import Project, ProjectMembership

SEND_EMAIL_JOB = "send_email"
CHECK_LLM_STAGE_EMAIL_JOB = "check_llm_stage_email"

TASK_LABELS = {
    LlmTaskType.TITLE_ABSTRACT_SCREENING: "title and abstract screening",
    LlmTaskType.FULL_TEXT_SCREENING: "full-text screening",
    LlmTaskType.DATA_EXTRACTION: "data extraction",
    LlmTaskType.EXTRACTION_VALIDATION: "extraction validation",
}


def _hash_key(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def queue_email_notification(
    db: Session,
    *,
    recipient: User,
    template: str,
    deduplication_key: str,
    context: dict[str, Any],
    project_id: str | None = None,
) -> EmailNotification | None:
    settings = get_settings()
    if not settings.email_enabled or not recipient.email or not recipient.is_active:
        return None

    hashed_key = _hash_key(deduplication_key)
    existing = db.scalar(
        select(EmailNotification).where(
            EmailNotification.deduplication_key == hashed_key
        )
    )
    if existing:
        return existing

    rendered = render_email(template, context)
    notification = EmailNotification(
        recipient_user_id=recipient.id,
        project_id=project_id,
        recipient_email=recipient.email,
        template=template,
        deduplication_key=hashed_key,
        subject=rendered.subject,
        context=context,
    )
    try:
        with db.begin_nested():
            db.add(notification)
            db.flush()
    except IntegrityError:
        concurrent = db.scalar(
            select(EmailNotification).where(
                EmailNotification.deduplication_key == hashed_key
            )
        )
        if concurrent is None:
            raise
        return concurrent
    enqueue_job(
        db,
        SEND_EMAIL_JOB,
        {"notification_id": notification.id},
        project_id=project_id,
        created_by_id=None,
        max_attempts=5,
        priority=20,
    )
    return notification


def queue_account_created_email(db: Session, user: User) -> EmailNotification | None:
    settings = get_settings()
    return queue_email_notification(
        db,
        recipient=user,
        template="account_created",
        deduplication_key=f"account-created:{user.id}",
        context={
            "recipient_name": user.display_name,
            "username": user.username,
            "login_url": f"{settings.public_base_url}/login",
        },
    )


def queue_password_reset_email(
    db: Session, user: User, raw_token: str
) -> EmailNotification | None:
    settings = get_settings()
    return queue_email_notification(
        db,
        recipient=user,
        template="password_reset",
        deduplication_key=f"password-reset:{_hash_key(raw_token)}",
        context={
            "recipient_name": user.display_name,
            "reset_url": f"{settings.public_base_url}/reset-password?token={raw_token}",
            "expires_in_minutes": settings.password_reset_ttl_minutes,
        },
    )


def queue_project_created_emails(
    db: Session, project: Project, creator: User
) -> list[EmailNotification]:
    """Notify active administrators once when a project is created."""
    administrators = list(
        db.scalars(
            select(User)
            .where(
                User.is_admin.is_(True),
                User.is_active.is_(True),
                User.email.is_not(None),
            )
            .order_by(User.id)
        )
    )
    settings = get_settings()
    notifications: list[EmailNotification] = []
    for administrator in administrators:
        notification = queue_email_notification(
            db,
            recipient=administrator,
            template="project_created",
            deduplication_key=f"project-created:{project.id}:{administrator.id}",
            context={
                "recipient_name": administrator.display_name,
                "project_name": project.name,
                "creator_name": creator.display_name,
                "project_url": f"{settings.public_base_url}/projects/{project.id}",
            },
            project_id=project.id,
        )
        if notification:
            notifications.append(notification)
    return notifications


def queue_membership_email(
    db: Session,
    *,
    membership: ProjectMembership,
    project: Project,
    user: User,
    added: bool,
) -> EmailNotification | None:
    settings = get_settings()
    template = "project_membership_added" if added else "project_membership_removed"
    context = {
        "recipient_name": user.display_name,
        "project_name": project.name,
        "project_url": f"{settings.public_base_url}/projects/{project.id}",
        "home_url": settings.public_base_url,
    }
    return queue_email_notification(
        db,
        recipient=user,
        template=template,
        deduplication_key=f"{template}:{membership.id}",
        context=context,
        project_id=project.id,
    )


def queue_project_completed_emails(
    db: Session, project: Project, completed_at: datetime
) -> list[EmailNotification]:
    """Notify active project owners once for this completion cycle."""
    owners = list(
        db.scalars(
            select(User)
            .join(ProjectMembership, ProjectMembership.user_id == User.id)
            .where(
                ProjectMembership.project_id == project.id,
                ProjectMembership.is_owner.is_(True),
            )
        )
    )
    settings = get_settings()
    notifications: list[EmailNotification] = []
    completion_key = completed_at.isoformat()
    for owner in owners:
        notification = queue_email_notification(
            db,
            recipient=owner,
            template="project_completed",
            deduplication_key=(
                f"project-completed:{project.id}:{completion_key}:{owner.id}"
            ),
            context={
                "recipient_name": owner.display_name,
                "project_name": project.name,
                "project_url": f"{settings.public_base_url}/projects/{project.id}",
            },
            project_id=project.id,
        )
        if notification:
            notifications.append(notification)
    return notifications


def queue_llm_bulk_completion_emails(
    db: Session, project_id: str, bulk_id: str
) -> list[EmailNotification]:
    active_statuses = {ProcessingStatus.PENDING, ProcessingStatus.PROCESSING}
    runs = list(
        db.scalars(
            select(LlmExtractionRun)
            .where(
                LlmExtractionRun.project_id == project_id,
                LlmExtractionRun.bulk_id == bulk_id,
            )
            .order_by(LlmExtractionRun.id)
        )
    )
    preparation_jobs = [
        job
        for job in db.scalars(
            select(BackgroundJob).where(
                BackgroundJob.project_id == project_id,
                BackgroundJob.job_type == "extract_document_text",
            )
        )
        if job.payload.get("bulk_id") == bulk_id
    ]
    if not runs and not preparation_jobs:
        return []
    if any(item.status in active_statuses for item in runs) or any(
        job.status in {JobStatus.QUEUED, JobStatus.RUNNING} for job in preparation_jobs
    ):
        return []

    project = db.get(Project, project_id)
    if project is None:
        return []
    owners = list(
        db.scalars(
            select(User)
            .join(ProjectMembership, ProjectMembership.user_id == User.id)
            .where(
                ProjectMembership.project_id == project.id,
                ProjectMembership.is_owner.is_(True),
            )
        )
    )
    completed = sum(item.status == ProcessingStatus.COMPLETED for item in runs)
    failed = sum(item.status == ProcessingStatus.FAILED for item in runs) + sum(
        job.status == JobStatus.FAILED for job in preparation_jobs
    )
    other = (
        len(runs)
        - sum(
            item.status in {ProcessingStatus.COMPLETED, ProcessingStatus.FAILED}
            for item in runs
        )
        + sum(job.status == JobStatus.CANCELLED for job in preparation_jobs)
    )
    stage_label = (
        ", ".join(
            TASK_LABELS[task_type]
            for task_type in sorted({item.task_type for item in runs}, key=str)
        )
        or "LLM processing"
    )
    settings = get_settings()
    notifications: list[EmailNotification] = []
    for owner in owners:
        notification = queue_email_notification(
            db,
            recipient=owner,
            template="llm_stage_completed",
            deduplication_key=f"llm-bulk-completed:{bulk_id}:{owner.id}",
            context={
                "recipient_name": owner.display_name,
                "project_name": project.name,
                "stage_label": stage_label,
                "bulk_id": bulk_id,
                "completed_count": completed,
                "failed_count": failed,
                "other_count": other,
                "project_url": f"{settings.public_base_url}/projects/{project.id}/admin",
            },
            project_id=project.id,
        )
        if notification:
            notifications.append(notification)
    return notifications


def queue_llm_stage_completion_emails(
    db: Session, run: LlmExtractionRun
) -> list[EmailNotification]:
    """Compatibility wrapper that deliberately ignores individually queued runs."""
    if not run.bulk_id:
        return []
    return queue_llm_bulk_completion_emails(db, run.project_id, run.bulk_id)


def queue_llm_bulk_completion_check(
    db: Session, *, project_id: str, bulk_id: str
) -> BackgroundJob | None:
    if not get_settings().email_enabled:
        return None
    return enqueue_job(
        db,
        CHECK_LLM_STAGE_EMAIL_JOB,
        {"bulk_id": bulk_id},
        project_id=project_id,
        created_by_id=None,
        max_attempts=3,
        priority=10,
    )


def queue_llm_stage_completion_check(
    db: Session, run: LlmExtractionRun
) -> BackgroundJob | None:
    if not run.bulk_id:
        return None
    return queue_llm_bulk_completion_check(
        db, project_id=run.project_id, bulk_id=run.bulk_id
    )


def check_llm_stage_email_job(db: Session, job: BackgroundJob) -> dict[str, Any]:
    bulk_id = str(job.payload.get("bulk_id", ""))
    if not bulk_id or not job.project_id:
        raise ValueError("LLM bulk context is missing")
    notifications = queue_llm_bulk_completion_emails(db, job.project_id, bulk_id)
    return {"notification_ids": [notification.id for notification in notifications]}


def send_email_job(db: Session, job: BackgroundJob) -> dict[str, Any]:
    notification = db.get(EmailNotification, str(job.payload.get("notification_id")))
    if notification is None:
        raise ValueError("Email notification not found")
    if notification.status == EmailDeliveryStatus.SENT:
        return {"notification_id": notification.id, "already_sent": True}

    notification.status = EmailDeliveryStatus.SENDING
    notification.attempts = job.attempts
    notification.error_message = None
    rendered = render_email(notification.template, notification.context)
    send_smtp_email(
        get_settings(), recipient=notification.recipient_email, rendered=rendered
    )
    notification.status = EmailDeliveryStatus.SENT
    notification.sent_at = datetime.now(UTC)
    return {"notification_id": notification.id}


def record_email_job_failure(db: Session, job: BackgroundJob, error: Exception) -> None:
    notification = db.get(EmailNotification, str(job.payload.get("notification_id")))
    if notification is None:
        return
    notification.attempts = job.attempts
    notification.error_message = str(error)[:2000]
    notification.status = (
        EmailDeliveryStatus.FAILED
        if job.status == JobStatus.FAILED
        else EmailDeliveryStatus.QUEUED
    )
