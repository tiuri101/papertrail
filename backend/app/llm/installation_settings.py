from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import Settings, get_settings
from app.llm.models import LlmInstallationSettings


def installation_settings(db: Session) -> LlmInstallationSettings | None:
    return db.scalar(
        select(LlmInstallationSettings).order_by(
            LlmInstallationSettings.created_at.desc()
        )
    )


def effective_llm_settings(db: Session | None = None) -> Settings:
    """Return environment defaults with administrator overrides applied."""

    if db is None:
        from app.db.session import SessionFactory

        with SessionFactory() as session:
            stored = installation_settings(session)
    else:
        stored = installation_settings(db)

    defaults = get_settings()
    if stored is None:
        return defaults
    return defaults.model_copy(
        update={
            "llm_enabled": stored.enabled,
            "ollama_base_url": stored.endpoint,
            "ollama_model": stored.model,
            "llm_context_length": stored.context_length,
        }
    )


def update_installation_settings(
    db: Session,
    *,
    enabled: bool,
    endpoint: str,
    model: str,
    context_length: int,
    updated_by_user_id: str,
) -> LlmInstallationSettings:
    stored = installation_settings(db)
    if stored is None:
        stored = LlmInstallationSettings(
            enabled=enabled,
            endpoint=endpoint,
            model=model,
            context_length=context_length,
            updated_by_user_id=updated_by_user_id,
        )
        db.add(stored)
    else:
        stored.enabled = enabled
        stored.endpoint = endpoint
        stored.model = model
        stored.context_length = context_length
        stored.updated_by_user_id = updated_by_user_id
    db.flush()
    return stored
