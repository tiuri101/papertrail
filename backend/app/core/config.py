from __future__ import annotations

from functools import lru_cache
from os import getenv
from pathlib import Path
from typing import Annotated
from urllib.parse import unquote, urlsplit

from pydantic import field_validator, model_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

#: Passwords that ship in example files, tutorials, and the Compose defaults.
#: A production installation that still uses one of these is not protected by a
#: secret at all, so startup refuses it. Compared case-insensitively; the value
#: itself is never echoed back in the error message.
WELL_KNOWN_WEAK_PASSWORDS = frozenset(
    {
        "admin",
        "change-me",
        "change_me",
        "changeme",
        "example",
        "papertrail",
        "papertrail-dev",
        "password",
        "postgres",
        "replace-with-a-generated-random-value",
        "replace-with-a-long-random-password",
        "root",
        "secret",
        "test",
    }
)


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
    # Documented, deliberately explicit escape hatch for the production
    # hardening checks below (for example a throwaway staging stack that runs
    # PAPERTRAIL_ENV=production behind plain HTTP on a private network). It is
    # never set by docker-compose.yml's defaults: an operator has to opt in.
    allow_insecure_production: bool = False
    # ``None`` means "decide from the environment": interactive API docs stay on
    # in development/test and are switched off in production.
    api_docs_enabled: bool | None = None
    database_url: str = "sqlite+pysqlite:///./papertrail.db"
    # Least-privilege runtime login provisioned by the migration container.
    # Only the migration/bootstrap process ever sees these: it owns the schema
    # and grants the runtime role DML-only access. The API and the workers
    # connect with that role through PAPERTRAIL_DATABASE_URL instead.
    runtime_database_role: str | None = None
    runtime_database_password: str | None = None
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
    # Baked into the backend Docker image at build time (see backend/Dockerfile);
    # absent in local/source dev, where the download endpoint reports 404.
    browser_extension_zip_path: Path = Path("./static/papertrail-browser-extension.zip")
    email_enabled: bool = False
    # High-entropy application secret used to encrypt credential-bearing email
    # payloads (currently the password-reset link) before they are persisted in
    # the notification queue. Supplied through the environment only: it must
    # never be stored in PostgreSQL, returned by an API, or logged.
    notification_encryption_key: str | None = None
    public_base_url: str = "http://localhost:5173"
    smtp_host: str | None = None
    smtp_port: int = 587
    smtp_username: str | None = None
    smtp_password: str | None = None
    smtp_from_address: str | None = None
    smtp_starttls: bool = True
    smtp_use_ssl: bool = False
    smtp_timeout_seconds: int = 30
    # Duplicate review calls Crossref / Semantic Scholar and probes each
    # candidate record's bibliographic URLs to suggest which record to keep
    # (and to auto-merge a provider-confirmed same-work pair). An installation
    # with no outbound internet access can switch the whole step off.
    duplicate_assessment_enabled: bool = True
    url_check_timeout_seconds: float = 8.0
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

    @field_validator("runtime_database_role", "runtime_database_password")
    @classmethod
    def normalize_optional_secret(cls, value: str | None) -> str | None:
        """Treat an empty Compose passthrough (``VAR: ${VAR:-}``) as unset."""
        if value is None or not value.strip():
            return None
        return value.strip()

    @field_validator("api_docs_enabled", mode="before")
    @classmethod
    def normalize_api_docs_enabled(cls, value: object) -> object:
        """Treat an empty Compose passthrough (``VAR: ${VAR:-}``) as unset."""
        if isinstance(value, str) and not value.strip():
            return None
        return value

    @property
    def is_production(self) -> bool:
        return self.env.strip().lower() == "production"

    @property
    def docs_enabled(self) -> bool:
        """Whether ``/docs``, ``/redoc``, and ``/openapi.json`` are served."""
        if self.api_docs_enabled is not None:
            return self.api_docs_enabled
        return not self.is_production

    @model_validator(mode="after")
    def validate_production_hardening(self) -> Settings:
        if not self.is_production or self.allow_insecure_production:
            return self
        problems = production_configuration_problems(self)
        if problems:
            raise ValueError(
                "Refusing to start with PAPERTRAIL_ENV=production and an insecure "
                "configuration:\n- "
                + "\n- ".join(problems)
                + "\nFix the settings above, or set "
                "PAPERTRAIL_ALLOW_INSECURE_PRODUCTION=true to accept the risk "
                "explicitly (never do this on an internet-facing installation)."
            )
        return self

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
        if self.url_check_timeout_seconds < 1:
            raise ValueError(
                "PAPERTRAIL_URL_CHECK_TIMEOUT_SECONDS must be at least 1"
            )
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


def _is_well_known_weak(secret: str | None) -> bool:
    return secret is not None and secret.strip().lower() in WELL_KNOWN_WEAK_PASSWORDS


def _database_password(database_url: str) -> str | None:
    try:
        password = urlsplit(database_url).password
    except ValueError:
        return None
    return unquote(password) if password else None


def production_configuration_problems(settings: Settings) -> list[str]:
    """Insecure production settings, as operator-readable messages.

    Papertrail terminates TLS at a reverse proxy and the API container speaks
    plain HTTP on the internal network -- that internal hop is expected and is
    *not* what these checks look at. ``public_base_url`` is different: it is the
    browser-facing origin baked into password-reset links and handed to the
    Browser Helper as its upload target, so it has to be the HTTPS address the
    proxy publishes.

    Messages name the setting and never contain a secret value.
    """
    problems: list[str] = []

    if not settings.session_cookie_secure:
        problems.append(
            "PAPERTRAIL_SESSION_COOKIE_SECURE is false, so the session cookie "
            "would be sent over plain HTTP. Set it to true and terminate TLS at "
            "the reverse proxy."
        )

    if urlsplit(settings.public_base_url).scheme != "https":
        problems.append(
            "PAPERTRAIL_PUBLIC_BASE_URL is not an https:// URL. It is the public "
            "origin used for password-reset links and Browser Helper uploads, so "
            "it must be the HTTPS address your reverse proxy publishes (the "
            "internal http:// hop to the API container is unaffected)."
        )

    if any(origin.strip() == "*" for origin in settings.cors_origins):
        problems.append(
            "PAPERTRAIL_CORS_ORIGINS contains '*'. Papertrail sends credentialed "
            "cross-origin requests, so a wildcard origin is never acceptable; "
            "list the exact origins instead."
        )

    if not settings.cors_origins:
        problems.append(
            "PAPERTRAIL_CORS_ORIGINS is empty. List the exact browser origin(s) "
            "that may call the API."
        )

    if any(host.strip() in {"*", "*.*"} for host in settings.allowed_hosts):
        problems.append(
            "PAPERTRAIL_ALLOWED_HOSTS contains '*', which disables Host-header "
            "validation entirely. List the exact hostnames this installation "
            "answers on (a '*.example.org' subdomain pattern is still allowed)."
        )

    if not settings.allowed_hosts:
        problems.append(
            "PAPERTRAIL_ALLOWED_HOSTS is empty. List the exact hostnames this "
            "installation answers on."
        )

    if _is_well_known_weak(_database_password(settings.database_url)):
        problems.append(
            "PAPERTRAIL_DATABASE_URL still uses a well-known example password "
            "(the value shipped in docker-compose.yml/.env.example). Generate a "
            "unique PostgreSQL password and update POSTGRES_PASSWORD."
        )

    if _is_well_known_weak(settings.runtime_database_password):
        problems.append(
            "PAPERTRAIL_RUNTIME_DATABASE_PASSWORD is a well-known example "
            "password. Generate a unique value."
        )

    if _is_well_known_weak(settings.notification_encryption_key):
        problems.append(
            "PAPERTRAIL_NOTIFICATION_ENCRYPTION_KEY is a well-known example "
            "value. Generate a unique high-entropy key."
        )

    return problems


@lru_cache
def get_settings() -> Settings:
    if getenv("PAPERTRAIL_ENV") == "test":
        return Settings(_env_file=None)  # type: ignore[call-arg]

    return Settings()
