from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.accounts.dependencies import require_admin, require_admin_csrf
from app.accounts.models import User
from app.audit.service import record_audit
from app.db.session import get_db
from app.instance_settings.schemas import InstanceSettingsUpdate, TestEmailResponse
from app.instance_settings.service import (
    effective_instance_settings,
    update_instance_settings,
)
from app.notifications.mailer import send_smtp_email
from app.notifications.templates import RenderedEmail

router = APIRouter(tags=["instance settings"])


def _to_response(config: Any) -> dict[str, Any]:
    return {
        "emailEnabled": config.email_enabled,
        "publicBaseUrl": config.public_base_url,
        "smtpHost": config.smtp_host,
        "smtpPort": config.smtp_port,
        "smtpUsername": config.smtp_username,
        "smtpPasswordSet": bool(config.smtp_password),
        "smtpFromAddress": config.smtp_from_address,
        "smtpStarttls": config.smtp_starttls,
        "smtpUseSsl": config.smtp_use_ssl,
        "smtpTimeoutSeconds": config.smtp_timeout_seconds,
        "workerThreads": config.worker_threads,
        "jobPollIntervalSeconds": config.job_poll_interval_seconds,
        "jobLeaseSeconds": config.job_lease_seconds,
        "browserRetrievalLeaseSeconds": config.browser_retrieval_lease_seconds,
        "maxPdfSizeMb": config.max_pdf_size_mb,
        "passwordResetTtlMinutes": config.password_reset_ttl_minutes,
        "passwordResetMaxAttempts": config.password_reset_max_attempts,
    }


@router.get("/instance-settings")
def get_instance_settings(
    _: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    return _to_response(effective_instance_settings(db))


@router.patch("/instance-settings")
def update_instance_settings_route(
    payload: InstanceSettingsUpdate,
    admin: User = Depends(require_admin_csrf),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    previous = effective_instance_settings(db)
    stored = update_instance_settings(
        db,
        email_enabled=payload.email_enabled,
        public_base_url=payload.public_base_url,
        smtp_host=payload.smtp_host,
        smtp_port=payload.smtp_port,
        smtp_username=payload.smtp_username,
        smtp_password=payload.smtp_password,
        smtp_from_address=payload.smtp_from_address,
        smtp_starttls=payload.smtp_starttls,
        smtp_use_ssl=payload.smtp_use_ssl,
        smtp_timeout_seconds=payload.smtp_timeout_seconds,
        worker_threads=payload.worker_threads,
        job_poll_interval_seconds=payload.job_poll_interval_seconds,
        job_lease_seconds=payload.job_lease_seconds,
        browser_retrieval_lease_seconds=payload.browser_retrieval_lease_seconds,
        max_pdf_size_mb=payload.max_pdf_size_mb,
        password_reset_ttl_minutes=payload.password_reset_ttl_minutes,
        password_reset_max_attempts=payload.password_reset_max_attempts,
        updated_by_user_id=admin.id,
    )
    changes: dict[str, Any] = {}
    for key, before, after in (
        ("emailEnabled", previous.email_enabled, stored.email_enabled),
        ("publicBaseUrl", previous.public_base_url, stored.public_base_url),
        ("smtpHost", previous.smtp_host, stored.smtp_host),
        ("smtpPort", previous.smtp_port, stored.smtp_port),
        ("smtpUsername", previous.smtp_username, stored.smtp_username),
        (
            "smtpPasswordSet",
            bool(previous.smtp_password),
            bool(stored.smtp_password),
        ),
        ("smtpFromAddress", previous.smtp_from_address, stored.smtp_from_address),
        ("smtpStarttls", previous.smtp_starttls, stored.smtp_starttls),
        ("smtpUseSsl", previous.smtp_use_ssl, stored.smtp_use_ssl),
        (
            "smtpTimeoutSeconds",
            previous.smtp_timeout_seconds,
            stored.smtp_timeout_seconds,
        ),
        ("workerThreads", previous.worker_threads, stored.worker_threads),
        (
            "jobPollIntervalSeconds",
            previous.job_poll_interval_seconds,
            stored.job_poll_interval_seconds,
        ),
        ("jobLeaseSeconds", previous.job_lease_seconds, stored.job_lease_seconds),
        (
            "browserRetrievalLeaseSeconds",
            previous.browser_retrieval_lease_seconds,
            stored.browser_retrieval_lease_seconds,
        ),
        ("maxPdfSizeMb", previous.max_pdf_size_mb, stored.max_pdf_size_mb),
        (
            "passwordResetTtlMinutes",
            previous.password_reset_ttl_minutes,
            stored.password_reset_ttl_minutes,
        ),
        (
            "passwordResetMaxAttempts",
            previous.password_reset_max_attempts,
            stored.password_reset_max_attempts,
        ),
    ):
        if before != after:
            changes[key] = {"from": before, "to": after}
    record_audit(
        db,
        action="instance_settings.updated",
        entity_type="instance_settings",
        entity_id=stored.id,
        actor_id=admin.id,
        summary="Updated instance settings",
        metadata={"changes": changes},
    )
    db.commit()
    return _to_response(stored)


@router.post("/instance-settings/test-email", response_model=TestEmailResponse)
def test_email(
    admin: User = Depends(require_admin_csrf),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    if not admin.email:
        return {"sent": False, "error": "Your account has no email address on file"}
    config = effective_instance_settings(db)
    rendered = RenderedEmail(
        subject="Papertrail test email",
        text_body=(
            "This is a test email from your Papertrail installation's "
            "instance settings. If you received this, SMTP delivery is "
            "configured correctly."
        ),
        html_body=(
            "<p>This is a test email from your Papertrail installation's "
            "instance settings.</p><p>If you received this, SMTP delivery "
            "is configured correctly.</p>"
        ),
    )
    try:
        send_smtp_email(config, recipient=admin.email, rendered=rendered)
    except Exception as exc:  # noqa: BLE001 - surfaced to the admin, not raised
        return {"sent": False, "error": str(exc)}
    return {"sent": True, "error": None}
