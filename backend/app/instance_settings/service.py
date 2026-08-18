from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import Settings, get_settings
from app.instance_settings.models import InstanceSettings


def instance_settings(db: Session) -> InstanceSettings | None:
    return db.scalar(
        select(InstanceSettings).order_by(InstanceSettings.created_at.desc())
    )


def effective_instance_settings(db: Session | None = None) -> Settings:
    """Return environment defaults with administrator overrides applied."""

    if db is None:
        from app.db.session import SessionFactory

        with SessionFactory() as session:
            stored = instance_settings(session)
    else:
        stored = instance_settings(db)

    defaults = get_settings()
    if stored is None:
        return defaults
    return defaults.model_copy(
        update={
            "email_enabled": stored.email_enabled,
            "public_base_url": stored.public_base_url,
            "smtp_host": stored.smtp_host,
            "smtp_port": stored.smtp_port,
            "smtp_username": stored.smtp_username,
            "smtp_password": stored.smtp_password,
            "smtp_from_address": stored.smtp_from_address,
            "smtp_starttls": stored.smtp_starttls,
            "smtp_use_ssl": stored.smtp_use_ssl,
            "smtp_timeout_seconds": stored.smtp_timeout_seconds,
            "worker_threads": stored.worker_threads,
            "job_poll_interval_seconds": stored.job_poll_interval_seconds,
            "job_lease_seconds": stored.job_lease_seconds,
            "browser_retrieval_lease_seconds": stored.browser_retrieval_lease_seconds,
            "max_pdf_size_mb": stored.max_pdf_size_mb,
            "password_reset_ttl_minutes": stored.password_reset_ttl_minutes,
            "password_reset_max_attempts": stored.password_reset_max_attempts,
        }
    )


def update_instance_settings(
    db: Session,
    *,
    email_enabled: bool,
    public_base_url: str,
    smtp_host: str | None,
    smtp_port: int,
    smtp_username: str | None,
    smtp_password: str | None,
    smtp_from_address: str | None,
    smtp_starttls: bool,
    smtp_use_ssl: bool,
    smtp_timeout_seconds: int,
    worker_threads: int,
    job_poll_interval_seconds: float,
    job_lease_seconds: int,
    browser_retrieval_lease_seconds: int,
    max_pdf_size_mb: int,
    password_reset_ttl_minutes: int,
    password_reset_max_attempts: int,
    updated_by_user_id: str,
) -> InstanceSettings:
    stored = instance_settings(db)
    if stored is None:
        stored = InstanceSettings(
            email_enabled=email_enabled,
            public_base_url=public_base_url,
            smtp_host=smtp_host,
            smtp_port=smtp_port,
            smtp_username=smtp_username,
            smtp_password=smtp_password,
            smtp_from_address=smtp_from_address,
            smtp_starttls=smtp_starttls,
            smtp_use_ssl=smtp_use_ssl,
            smtp_timeout_seconds=smtp_timeout_seconds,
            worker_threads=worker_threads,
            job_poll_interval_seconds=job_poll_interval_seconds,
            job_lease_seconds=job_lease_seconds,
            browser_retrieval_lease_seconds=browser_retrieval_lease_seconds,
            max_pdf_size_mb=max_pdf_size_mb,
            password_reset_ttl_minutes=password_reset_ttl_minutes,
            password_reset_max_attempts=password_reset_max_attempts,
            updated_by_user_id=updated_by_user_id,
        )
        db.add(stored)
    else:
        stored.email_enabled = email_enabled
        stored.public_base_url = public_base_url
        stored.smtp_host = smtp_host
        stored.smtp_port = smtp_port
        stored.smtp_username = smtp_username
        # A blank submission keeps the previously stored password -- the
        # field is never echoed back to the client, so blank cannot mean
        # "clear it".
        if smtp_password is not None:
            stored.smtp_password = smtp_password
        stored.smtp_from_address = smtp_from_address
        stored.smtp_starttls = smtp_starttls
        stored.smtp_use_ssl = smtp_use_ssl
        stored.smtp_timeout_seconds = smtp_timeout_seconds
        stored.worker_threads = worker_threads
        stored.job_poll_interval_seconds = job_poll_interval_seconds
        stored.job_lease_seconds = job_lease_seconds
        stored.browser_retrieval_lease_seconds = browser_retrieval_lease_seconds
        stored.max_pdf_size_mb = max_pdf_size_mb
        stored.password_reset_ttl_minutes = password_reset_ttl_minutes
        stored.password_reset_max_attempts = password_reset_max_attempts
        stored.updated_by_user_id = updated_by_user_id
    db.flush()
    return stored
