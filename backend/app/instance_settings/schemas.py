from __future__ import annotations

from urllib.parse import urlsplit

from pydantic import Field, field_validator, model_validator

from app.api.schemas import EnumApiModel as ApiModel


class InstanceSettingsUpdate(ApiModel):
    email_enabled: bool = Field(alias="emailEnabled")
    public_base_url: str = Field(alias="publicBaseUrl")
    smtp_host: str | None = Field(default=None, alias="smtpHost")
    smtp_port: int = Field(alias="smtpPort", ge=1, le=65535)
    smtp_username: str | None = Field(default=None, alias="smtpUsername")
    smtp_password: str | None = Field(default=None, alias="smtpPassword")
    smtp_from_address: str | None = Field(default=None, alias="smtpFromAddress")
    smtp_starttls: bool = Field(alias="smtpStarttls")
    smtp_use_ssl: bool = Field(alias="smtpUseSsl")
    smtp_timeout_seconds: int = Field(alias="smtpTimeoutSeconds", ge=1)
    worker_threads: int = Field(alias="workerThreads", ge=1)
    job_poll_interval_seconds: float = Field(alias="jobPollIntervalSeconds", gt=0)
    job_lease_seconds: int = Field(alias="jobLeaseSeconds", ge=1)
    browser_retrieval_lease_seconds: int = Field(
        alias="browserRetrievalLeaseSeconds", ge=1
    )
    max_pdf_size_mb: int = Field(alias="maxPdfSizeMb", ge=1)
    password_reset_ttl_minutes: int = Field(alias="passwordResetTtlMinutes", ge=1)
    password_reset_max_attempts: int = Field(alias="passwordResetMaxAttempts", ge=1)

    @field_validator("smtp_host", "smtp_username", "smtp_password", "smtp_from_address")
    @classmethod
    def normalize_optional_string(cls, value: str | None) -> str | None:
        if value is None or not value.strip():
            return None
        return value.strip()

    @field_validator("public_base_url")
    @classmethod
    def validate_public_base_url(cls, value: str) -> str:
        normalized = value.strip().rstrip("/")
        parsed = urlsplit(normalized)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise ValueError("Public base URL must be a valid HTTP(S) URL")
        return normalized

    @model_validator(mode="after")
    def validate_combination(self) -> InstanceSettingsUpdate:
        if self.email_enabled and (not self.smtp_host or not self.smtp_from_address):
            raise ValueError(
                "SMTP host and from address are required when email is enabled"
            )
        if self.smtp_starttls and self.smtp_use_ssl:
            raise ValueError("STARTTLS and implicit SSL cannot both be enabled")
        return self


class TestEmailResponse(ApiModel):
    sent: bool
    error: str | None = None
