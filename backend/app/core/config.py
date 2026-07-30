from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Annotated

from pydantic import field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="PAPERTRAIL_",
        env_file=(".env", ".env.development", "../.env", "../.env.development"),
        extra="ignore",
    )

    env: str = "development"
    app_name: str = "Papertrail"
    api_prefix: str = "/api/v1"
    database_url: str = "sqlite+pysqlite:///./papertrail.db"
    cors_origins: Annotated[list[str], NoDecode] = ["http://localhost:5173"]
    session_cookie_name: str = "papertrail_session"
    session_cookie_secure: bool = False
    session_ttl_hours: int = 24 * 7
    login_max_attempts: int = 5
    login_window_seconds: int = 900
    login_block_seconds: int = 900
    allowed_hosts: Annotated[list[str], NoDecode] = ["localhost", "127.0.0.1", "testserver"]
    max_upload_bytes: int = 25 * 1024 * 1024
    import_dir: Path = Path("./data/imports")
    export_dir: Path = Path("./data/exports")
    worker_threads: int = 4
    job_poll_interval_seconds: float = 1.0
    job_lease_seconds: int = 300

    @field_validator("cors_origins", "allowed_hosts", mode="before")
    @classmethod
    def parse_origins(cls, value: object) -> object:
        if isinstance(value, str):
            return [part.strip() for part in value.split(",") if part.strip()]
        return value

    def ensure_directories(self) -> None:
        self.import_dir.mkdir(parents=True, exist_ok=True)
        self.export_dir.mkdir(parents=True, exist_ok=True)


@lru_cache
def get_settings() -> Settings:
    return Settings()
