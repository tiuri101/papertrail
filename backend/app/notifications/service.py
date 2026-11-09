from __future__ import annotations

import hashlib
import logging
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.accounts.models import User
from app.imports.models import ImportBatch, ImportStatus
from app.instance_settings.service import effective_instance_settings
from app.jobs.models import BackgroundJob, JobStatus
from app.jobs.service import enqueue_job
from app.llm.models import LlmExtractionRun, LlmTaskType, ProcessingStatus
from app.notifications.encryption import (
    NotificationEncryptionError,
    decrypt_payload,
    encrypt_payload,
)
from app.notifications.mailer import send_smtp_email
from app.notifications.models import EmailDeliveryStatus, EmailNotification
from app.notifications.preferences import wants_email
from app.notifications.templates import render_email
from app.projects.models import Project, ProjectMembership, ProjectStage

logger = logging.getLogger(__name__)

SEND_EMAIL_JOB = "send_email"
CHECK_LLM_STAGE_EMAIL_JOB = "check_llm_stage_email"
TEXT_PREPARATION_JOB = "extract_document_text"

#: How long a project's LLM queue must stay drained before the "LLM
#: processing finished" email goes out. Long enough to bridge the gaps while
#: a reviewer releases publications into screening one at a time.
LLM_DIGEST_QUIET_PERIOD = timedelta(minutes=10)

_ACTIVE_RUN_STATUSES = (ProcessingStatus.PENDING, ProcessingStatus.PROCESSING)

#: Templates whose rendering needs the encrypted half of the payload. Listed so
#: a notification that has lost it fails with a clear message instead of a
#: KeyError deep inside template rendering.
SECRET_PAYLOAD_TEMPLATES = frozenset({"password_reset"})

TASK_LABELS = {
    LlmTaskType.TITLE_ABSTRACT_SCREENING: "title and abstract screening",
    LlmTaskType.FULL_TEXT_SCREENING: "full-text screening",
    LlmTaskType.DATA_EXTRACTION: "data extraction",
    LlmTaskType.EXTRACTION_VALIDATION: "extraction validation",
}


def _hash_key(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _project_owner_users(db: Session, project_id: str) -> list[User]:
    return list(
        db.scalars(
            select(User)
            .join(ProjectMembership, ProjectMembership.user_id == User.id)
            .where(
                ProjectMembership.project_id == project_id,
                ProjectMembership.is_owner.is_(True),
            )
        )
    )


def _payload_associated_data(template: str, recipient_email: str) -> str:
    """Bind a ciphertext to the row it belongs to, so an encrypted payload
    cannot be copied into a different notification and still decrypt."""
    return f"{template}\x1f{recipient_email}"


def queue_email_notification(
    db: Session,
    *,
    recipient: User,
    template: str,
    deduplication_key: str,
    context: dict[str, Any],
    project_id: str | None = None,
    secret_context: dict[str, Any] | None = None,
) -> EmailNotification | None:
    """Persist one email for the worker to deliver.

    ``context`` is ordinary, non-sensitive template data and is stored as plain
    JSON. ``secret_context`` holds credential-bearing fields (a reset link);
    it is merged into the template context only in memory and persisted solely
    as an authenticated-encryption envelope, so the stored row never contains a
    usable credential.
    """
    settings = effective_instance_settings(db)
    if not settings.email_enabled or not recipient.email or not recipient.is_active:
        return None
    if not wants_email(recipient, template):
        return None

    hashed_key = _hash_key(deduplication_key)
    existing = db.scalar(
        select(EmailNotification).where(
            EmailNotification.deduplication_key == hashed_key
        )
    )
    if existing:
        return existing

    rendered = render_email(template, {**context, **(secret_context or {})})
    encrypted_context = (
        encrypt_payload(
            secret_context,
            associated_data=_payload_associated_data(template, recipient.email),
        )
        if secret_context
        else None
    )
    notification = EmailNotification(
        recipient_user_id=recipient.id,
        project_id=project_id,
        recipient_email=recipient.email,
        template=template,
        deduplication_key=hashed_key,
        subject=rendered.subject,
        context=context,
        encrypted_context=encrypted_context,
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
    settings = effective_instance_settings(db)
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
    db: Session, user: User, raw_token: str, *, reset_token_id: str
) -> EmailNotification | None:
    """Queue the emailed reset link.

    The link is the credential, so it goes into ``secret_context`` and is
    persisted encrypted. The deduplication key is derived from the reset-token
    row id rather than the token itself -- nothing token-derived is written to
    this table.
    """
    settings = effective_instance_settings(db)
    return queue_email_notification(
        db,
        recipient=user,
        template="password_reset",
        deduplication_key=f"password-reset:{reset_token_id}",
        context={
            "recipient_name": user.display_name,
            "expires_in_minutes": settings.password_reset_ttl_minutes,
        },
        secret_context={
            "reset_url": f"{settings.public_base_url}/reset-password?token={raw_token}",
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
    settings = effective_instance_settings(db)
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
    settings = effective_instance_settings(db)
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
    owners = _project_owner_users(db, project.id)
    settings = effective_instance_settings(db)
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


def queue_project_stage_completed_emails(
    db: Session, project: Project, completed_stage: ProjectStage, completed_at: datetime
) -> list[EmailNotification]:
    """Notify active project owners once when a workflow stage finishes.

    Distinct from ``queue_project_completed_emails``, which fires when the
    whole project reaches ``ProjectStage.COMPLETED``: this fires for each
    intermediate stage transition (e.g. duplicate review -> title/abstract).
    """
    from app.projects.checklist import STAGE_LABELS

    owners = _project_owner_users(db, project.id)
    settings = effective_instance_settings(db)
    notifications: list[EmailNotification] = []
    stage_key = completed_stage.value
    completion_key = completed_at.isoformat()
    for owner in owners:
        notification = queue_email_notification(
            db,
            recipient=owner,
            template="project_stage_completed",
            deduplication_key=(
                f"project-stage-completed:{project.id}:{stage_key}:"
                f"{completion_key}:{owner.id}"
            ),
            context={
                "recipient_name": owner.display_name,
                "project_name": project.name,
                "stage_label": STAGE_LABELS[completed_stage],
                "new_stage_label": STAGE_LABELS[project.stage],
                "project_url": f"{settings.public_base_url}/projects/{project.id}",
            },
            project_id=project.id,
        )
        if notification:
            notifications.append(notification)
    return notifications


def queue_project_copy_completed_email(
    db: Session,
    recipient: User,
    *,
    job_id: str,
    source_project_name: str,
    target_project_id: str,
    target_project_name: str,
    missing_files: int,
) -> EmailNotification | None:
    settings = effective_instance_settings(db)
    return queue_email_notification(
        db,
        recipient=recipient,
        template="project_copy_completed",
        deduplication_key=f"project-copy-completed:{job_id}",
        context={
            "recipient_name": recipient.display_name,
            "source_project_name": source_project_name,
            "project_name": target_project_name,
            "missing_files": missing_files,
            "project_url": f"{settings.public_base_url}/projects/{target_project_id}",
        },
        project_id=target_project_id,
    )


def queue_project_copy_failed_email(
    db: Session, job: BackgroundJob, error: str
) -> None:
    """Permanent-failure hook: tell whoever requested a project copy it failed."""
    recipient = db.get(User, job.created_by_id) if job.created_by_id else None
    project = db.get(Project, job.project_id) if job.project_id else None
    if recipient is None or project is None:
        return
    settings = effective_instance_settings(db)
    queue_email_notification(
        db,
        recipient=recipient,
        template="project_copy_failed",
        deduplication_key=f"project-copy-failed:{job.id}",
        context={
            "recipient_name": recipient.display_name,
            "source_project_name": project.name,
            "project_name": str(job.payload.get("name", "")),
            "error_message": error[:500] or "unknown error",
            "project_url": f"{settings.public_base_url}/projects/{project.id}/admin",
        },
        project_id=project.id,
    )


def queue_failure_email_safely(
    db: Session, queue: Callable[[], object], *, job: BackgroundJob
) -> None:
    """Queue a failure email from a permanent-failure hook without risking
    the hook's own state change: the email gets its own SAVEPOINT, and a
    problem queueing it is logged instead of undoing that change."""
    try:
        with db.begin_nested():
            queue()
    except Exception:
        logger.exception(
            "Could not queue the failure email for background job %s (%s)",
            job.id,
            job.job_type,
        )


def queue_import_completed_email(
    db: Session, batch: ImportBatch
) -> EmailNotification | None:
    recipient = db.get(User, batch.created_by_id)
    project = db.get(Project, batch.project_id)
    if recipient is None or project is None:
        return None
    settings = effective_instance_settings(db)
    return queue_email_notification(
        db,
        recipient=recipient,
        template="import_completed",
        deduplication_key=f"import-completed:{batch.id}",
        context={
            "recipient_name": recipient.display_name,
            "project_name": project.name,
            "filename": batch.original_filename,
            "record_count": batch.record_count,
            "invalid_count": batch.invalid_record_count,
            "project_url": f"{settings.public_base_url}/projects/{project.id}/imports",
        },
        project_id=project.id,
    )


def queue_import_failed_email(
    db: Session, batch: ImportBatch, *, job_id: str, error: str
) -> EmailNotification | None:
    recipient = db.get(User, batch.created_by_id)
    project = db.get(Project, batch.project_id)
    if recipient is None or project is None:
        return None
    settings = effective_instance_settings(db)
    return queue_email_notification(
        db,
        recipient=recipient,
        template="import_failed",
        deduplication_key=f"import-failed:{job_id}",
        context={
            "recipient_name": recipient.display_name,
            "project_name": project.name,
            "filename": batch.original_filename,
            "records_imported": batch.status == ImportStatus.COMPLETED,
            "error_message": error[:500] or "unknown error",
            "project_url": f"{settings.public_base_url}/projects/{project.id}/imports",
        },
        project_id=project.id,
    )


def queue_duplicate_detection_failed_emails(
    db: Session, project_id: str, *, job_id: str, error: str
) -> list[EmailNotification]:
    project = db.get(Project, project_id)
    if project is None:
        return []
    settings = effective_instance_settings(db)
    notifications: list[EmailNotification] = []
    for owner in _project_owner_users(db, project.id):
        notification = queue_email_notification(
            db,
            recipient=owner,
            template="duplicate_detection_failed",
            deduplication_key=f"duplicate-detection-failed:{job_id}:{owner.id}",
            context={
                "recipient_name": owner.display_name,
                "project_name": project.name,
                "error_message": error[:500] or "unknown error",
                "project_url": f"{settings.public_base_url}/projects/{project.id}/duplicates",
            },
            project_id=project.id,
        )
        if notification:
            notifications.append(notification)
    return notifications


def _llm_digest_items(
    db: Session, project_id: str, since: datetime | None
) -> tuple[list[LlmExtractionRun], list[BackgroundJob]]:
    """Batch LLM work that finished after ``since``: runs queued as part of a
    bulk, plus the text-preparation jobs whose failure kept a bulk's runs from
    ever being created."""
    run_query = select(LlmExtractionRun).where(
        LlmExtractionRun.project_id == project_id,
        LlmExtractionRun.bulk_id.is_not(None),
        LlmExtractionRun.status.not_in(_ACTIVE_RUN_STATUSES),
        LlmExtractionRun.completed_at.is_not(None),
    )
    job_query = select(BackgroundJob).where(
        BackgroundJob.project_id == project_id,
        BackgroundJob.job_type == TEXT_PREPARATION_JOB,
        BackgroundJob.status.in_([JobStatus.FAILED, JobStatus.CANCELLED]),
        BackgroundJob.completed_at.is_not(None),
    )
    if since is not None:
        run_query = run_query.where(LlmExtractionRun.completed_at > since)
        job_query = job_query.where(BackgroundJob.completed_at > since)
    runs = list(db.scalars(run_query.order_by(LlmExtractionRun.id)))
    preparation_jobs = [
        job for job in db.scalars(job_query) if job.payload.get("bulk_id")
    ]
    return runs, preparation_jobs


def _llm_work_pending(db: Session, project_id: str) -> bool:
    active_run = db.scalar(
        select(LlmExtractionRun.id)
        .where(
            LlmExtractionRun.project_id == project_id,
            LlmExtractionRun.status.in_(_ACTIVE_RUN_STATUSES),
        )
        .limit(1)
    )
    if active_run is not None:
        return True
    active_preparation = db.scalar(
        select(BackgroundJob.id)
        .where(
            BackgroundJob.project_id == project_id,
            BackgroundJob.job_type == TEXT_PREPARATION_JOB,
            BackgroundJob.status.in_([JobStatus.QUEUED, JobStatus.RUNNING]),
        )
        .limit(1)
    )
    return active_preparation is not None


def _as_aware(value: datetime) -> datetime:
    # SQLite hands timezone-aware columns back naive; they are stored as UTC.
    return value if value.tzinfo is not None else value.replace(tzinfo=UTC)


def queue_llm_digest_emails(
    db: Session, project_id: str, *, now: datetime | None = None
) -> tuple[list[EmailNotification], datetime | None]:
    """Report all of a project's batch LLM work that finished since the last
    report, in one email per owner -- but only once the project's LLM queue
    has drained and stayed quiet for ``LLM_DIGEST_QUIET_PERIOD``.

    Returns the queued notifications and, when it is too early to report,
    the moment to check again (``None`` once nothing is left to wait for).
    """
    now = now or datetime.now(UTC)
    # Serializes concurrent checks for one project: the second sees the
    # cursor the first advanced and finds nothing left to report.
    project = db.scalar(
        select(Project).where(Project.id == project_id).with_for_update()
    )
    if project is None:
        return [], None
    if _llm_work_pending(db, project_id):
        # Finishing the remaining work reschedules this check anyway; the
        # retry here covers work that ends without a completion hook (a run
        # cancelled from the UI).
        return [], now + LLM_DIGEST_QUIET_PERIOD

    since = (
        _as_aware(project.llm_notified_through)
        if project.llm_notified_through
        else None
    )
    runs, preparation_jobs = _llm_digest_items(db, project_id, since)
    if not runs and not preparation_jobs:
        return [], None
    finished_through = max(
        _as_aware(completed_at)
        for completed_at in [
            *(run.completed_at for run in runs),
            *(job.completed_at for job in preparation_jobs),
        ]
        if completed_at is not None
    )
    quiet_until = finished_through + LLM_DIGEST_QUIET_PERIOD
    if quiet_until > now:
        return [], quiet_until

    completed = sum(item.status == ProcessingStatus.COMPLETED for item in runs)
    failed = sum(item.status == ProcessingStatus.FAILED for item in runs) + sum(
        job.status == JobStatus.FAILED for job in preparation_jobs
    )
    other = len(runs) + len(preparation_jobs) - completed - failed
    stage_label = (
        ", ".join(
            TASK_LABELS[task_type]
            for task_type in sorted({item.task_type for item in runs}, key=str)
        )
        or "LLM processing"
    )
    project.llm_notified_through = finished_through
    settings = effective_instance_settings(db)
    notifications: list[EmailNotification] = []
    for owner in _project_owner_users(db, project.id):
        notification = queue_email_notification(
            db,
            recipient=owner,
            template="llm_stage_completed",
            deduplication_key=(
                f"llm-digest:{project.id}:{finished_through.isoformat()}:{owner.id}"
            ),
            context={
                "recipient_name": owner.display_name,
                "project_name": project.name,
                "stage_label": stage_label,
                "completed_count": completed,
                "failed_count": failed,
                "other_count": other,
                "project_url": f"{settings.public_base_url}/projects/{project.id}/admin",
            },
            project_id=project.id,
        )
        if notification:
            notifications.append(notification)
    return notifications, None


def schedule_llm_digest_check(
    db: Session, project_id: str, *, not_before: datetime | None = None
) -> BackgroundJob | None:
    """Make sure one digest check is waiting for this project, due no earlier
    than ``not_before`` (default: one quiet period from now).

    Called whenever batch LLM work finishes. Each call pushes the waiting
    check further out, so a steady trickle of finishing runs -- a reviewer
    resolving duplicates one at a time, each releasing a publication into
    screening -- produces a single email once the trickle stops, not one per
    publication.
    """
    if not effective_instance_settings(db).email_enabled:
        return None
    due = not_before or datetime.now(UTC) + LLM_DIGEST_QUIET_PERIOD
    waiting = db.scalar(
        select(BackgroundJob)
        .where(
            BackgroundJob.project_id == project_id,
            BackgroundJob.job_type == CHECK_LLM_STAGE_EMAIL_JOB,
            BackgroundJob.status == JobStatus.QUEUED,
        )
        .order_by(BackgroundJob.created_at)
        .limit(1)
    )
    if waiting is not None:
        if waiting.run_after is None or _as_aware(waiting.run_after) < due:
            waiting.run_after = due
        return waiting
    return enqueue_job(
        db,
        CHECK_LLM_STAGE_EMAIL_JOB,
        {},
        project_id=project_id,
        created_by_id=None,
        max_attempts=3,
        priority=10,
        run_after=due,
    )


def schedule_llm_digest_after_run(
    db: Session, run: LlmExtractionRun
) -> BackgroundJob | None:
    # A run a reviewer started for one publication is visible where they
    # started it; only batch (bulk) work is worth an email.
    if not run.bulk_id:
        return None
    return schedule_llm_digest_check(db, run.project_id)


def check_llm_stage_email_job(db: Session, job: BackgroundJob) -> dict[str, Any]:
    if not job.project_id:
        raise ValueError("LLM digest project is missing")
    notifications, retry_at = queue_llm_digest_emails(db, job.project_id)
    if retry_at is not None:
        schedule_llm_digest_check(db, job.project_id, not_before=retry_at)
    return {
        "notification_ids": [notification.id for notification in notifications],
        **({"rescheduledFor": retry_at.isoformat()} if retry_at else {}),
    }


def send_email_job(db: Session, job: BackgroundJob) -> dict[str, Any]:
    notification = db.get(EmailNotification, str(job.payload.get("notification_id")))
    if notification is None:
        raise ValueError("Email notification not found")
    if notification.status == EmailDeliveryStatus.SENT:
        return {"notification_id": notification.id, "already_sent": True}

    notification.status = EmailDeliveryStatus.SENDING
    notification.attempts = job.attempts
    notification.error_message = None
    context = dict(notification.context)
    if (
        notification.template in SECRET_PAYLOAD_TEMPLATES
        and not notification.encrypted_context
    ):
        # Reached when a permanently failed job is restarted: the encrypted
        # link was discarded with the failure, and the reset token has almost
        # certainly expired anyway.
        raise ValueError(
            "This email can no longer be delivered: its encrypted payload was "
            "discarded after delivery failed. The recipient must request a new "
            "password reset link."
        )
    if notification.encrypted_context:
        try:
            context.update(
                decrypt_payload(
                    notification.encrypted_context,
                    associated_data=_payload_associated_data(
                        notification.template, notification.recipient_email
                    ),
                )
            )
        except NotificationEncryptionError as exc:
            # `str(exc)` is deliberately sanitized in app.notifications.
            # encryption: it names the misconfigured setting and nothing else,
            # so it is safe to store on the job and the notification row.
            raise ValueError(
                f"Email payload could not be prepared: {exc}"
            ) from None
    rendered = render_email(notification.template, context)
    send_smtp_email(
        effective_instance_settings(db),
        recipient=notification.recipient_email,
        rendered=rendered,
    )
    notification.status = EmailDeliveryStatus.SENT
    notification.sent_at = datetime.now(UTC)
    # The credential has reached the recipient; keep nothing behind.
    notification.encrypted_context = None
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
    if notification.status == EmailDeliveryStatus.FAILED:
        # Nothing will ever read this envelope again, so stop carrying an
        # encrypted credential around in the queue table.
        notification.encrypted_context = None
