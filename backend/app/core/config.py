from __future__ import annotations

from functools import lru_cache
from os import getenv
from pathlib import Path
from typing import Annotated
from urllib.parse import urlsplit

from pydantic import field_validator, model_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="PAPERTRAIL_",
        env_file=(".env", ".env.development", "../.env", "../.env.development"),
        extra="ignore",
    )

    env: str = "development"
    app_name: str = "Papertrail"
    app_version: str = "dev"
    api_prefix: str = "/api/v1"
    database_url: str = "sqlite+pysqlite:///./papertrail.db"
    cors_origins: Annotated[list[str], NoDecode] = ["http://localhost:5173"]
    session_cookie_name: str = "papertrail_session"
    session_cookie_secure: bool = False
    session_ttl_hours: int = 24 * 7
    login_max_attempts: int = 5
    login_window_seconds: int = 900
    login_block_seconds: int = 900
    password_reset_ttl_minutes: int = 60
    password_reset_max_attempts: int = 5
    allowed_hosts: Annotated[list[str], NoDecode] = [
        "localhost",
        "127.0.0.1",
        "testserver",
    ]
    max_upload_bytes: int = 25 * 1024 * 1024
    import_dir: Path = Path("./data/imports")
    export_dir: Path = Path("./data/exports")
    pdf_storage_path: Path = Path("./data/pdfs")
    max_pdf_size_mb: int = 50
    max_pdf_archive_size_mb: int = 500
    max_pdf_batch_files: int = 1000
    max_pdf_zip_expanded_bytes: int = 1024 * 1024 * 1024
    worker_threads: int = 4
    job_poll_interval_seconds: float = 1.0
    job_lease_seconds: int = 300
    browser_agent_pairing_ttl_minutes: int = 10
    browser_retrieval_lease_seconds: int = 300
    email_enabled: bool = False
    public_base_url: str = "http://localhost:5173"
    smtp_host: str | None = None
    smtp_port: int = 587
    smtp_username: str | None = None
    smtp_password: str | None = None
    smtp_from_address: str | None = None
    smtp_starttls: bool = True
    smtp_use_ssl: bool = False
    smtp_timeout_seconds: int = 30
    llm_enabled: bool = False
    ollama_base_url: str | None = None
    ollama_model: str | None = None
    ollama_request_timeout_seconds: int = 300
    ollama_api_key: str | None = None
    llm_max_concurrent_jobs: int = 1
    llm_context_length: int = 32768
    llm_max_evidence_items: int = 3
    llm_max_evidence_quote_chars: int = 500
    llm_title_abstract_base_prompt: str | None = None
    llm_full_text_base_prompt: str | None = None
    llm_extraction_base_prompt: str | None = None
    llm_validation_base_prompt: str | None = None

    @field_validator("cors_origins", "allowed_hosts", mode="before")
    @classmethod
    def parse_origins(cls, value: object) -> object:
        if isinstance(value, str):
            return [part.strip() for part in value.split(",") if part.strip()]
        return value

    @field_validator("ollama_base_url")
    @classmethod
    def normalize_ollama_base_url(cls, value: str | None) -> str | None:
        if value is None or not value.strip():
            return None
        return value.strip().rstrip("/")

    @field_validator("public_base_url")
    @classmethod
    def normalize_public_base_url(cls, value: str) -> str:
        return value.strip().rstrip("/")

    @field_validator(
        "ollama_model",
        "ollama_api_key",
        "smtp_host",
        "smtp_username",
        "smtp_password",
        "smtp_from_address",
    )
    @classmethod
    def normalize_optional_llm_string(cls, value: str | None) -> str | None:
        if value is None or not value.strip():
            return None
        return value.strip()

    @model_validator(mode="after")
    def validate_external_service_configuration(self) -> Settings:
        if self.email_enabled and (not self.smtp_host or not self.smtp_from_address):
            raise ValueError(
                "PAPERTRAIL_SMTP_HOST and PAPERTRAIL_SMTP_FROM_ADDRESS are required "
                "when PAPERTRAIL_EMAIL_ENABLED is true"
            )
        if self.smtp_starttls and self.smtp_use_ssl:
            raise ValueError(
                "PAPERTRAIL_SMTP_STARTTLS and PAPERTRAIL_SMTP_USE_SSL cannot both be true"
            )
        if not 1 <= self.smtp_port <= 65535:
            raise ValueError("PAPERTRAIL_SMTP_PORT must be a valid TCP port")
        if self.smtp_timeout_seconds < 1:
            raise ValueError("PAPERTRAIL_SMTP_TIMEOUT_SECONDS must be at least 1")
        if self.password_reset_ttl_minutes < 1:
            raise ValueError("PAPERTRAIL_PASSWORD_RESET_TTL_MINUTES must be at least 1")
        if self.password_reset_max_attempts < 1:
            raise ValueError(
                "PAPERTRAIL_PASSWORD_RESET_MAX_ATTEMPTS must be at least 1"
            )
        parsed_public_url = urlsplit(self.public_base_url)
        if (
            parsed_public_url.scheme not in {"http", "https"}
            or not parsed_public_url.netloc
        ):
            raise ValueError("PAPERTRAIL_PUBLIC_BASE_URL must be an HTTP(S) URL")
        if self.llm_enabled and (not self.ollama_base_url or not self.ollama_model):
            raise ValueError(
                "PAPERTRAIL_OLLAMA_BASE_URL and PAPERTRAIL_OLLAMA_MODEL are required "
                "when PAPERTRAIL_LLM_ENABLED is true"
            )
        if self.ollama_base_url:
            parsed = urlsplit(self.ollama_base_url)
            if parsed.scheme not in {"http", "https"} or not parsed.netloc:
                raise ValueError(
                    "PAPERTRAIL_OLLAMA_BASE_URL must be an HTTP(S) server URL"
                )
        if self.llm_max_concurrent_jobs < 1:
            raise ValueError("PAPERTRAIL_LLM_MAX_CONCURRENT_JOBS must be at least 1")
        if self.ollama_request_timeout_seconds < 1:
            raise ValueError(
                "PAPERTRAIL_OLLAMA_REQUEST_TIMEOUT_SECONDS must be at least 1"
            )
        if self.llm_context_length < 4096:
            raise ValueError("PAPERTRAIL_LLM_CONTEXT_LENGTH must be at least 4096")
        if not 1 <= self.llm_max_evidence_items <= 10:
            raise ValueError(
                "PAPERTRAIL_LLM_MAX_EVIDENCE_ITEMS must be between 1 and 10"
            )
        if not 50 <= self.llm_max_evidence_quote_chars <= 2000:
            raise ValueError(
                "PAPERTRAIL_LLM_MAX_EVIDENCE_QUOTE_CHARS must be between 50 and 2000"
            )
        return self

    def ensure_directories(self) -> None:
        self.import_dir.mkdir(parents=True, exist_ok=True)
        self.export_dir.mkdir(parents=True, exist_ok=True)
        self.pdf_storage_path.mkdir(parents=True, exist_ok=True)


@lru_cache
def get_settings() -> Settings:
    if getenv("PAPERTRAIL_ENV") == "test":
        return Settings(_env_file=None)  # type: ignore[call-arg]

    return Settings()
