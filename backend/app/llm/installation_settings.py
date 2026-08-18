from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import Settings, get_settings
from app.llm.models import LlmInstallationSettings

PROMPT_OVERRIDE_FIELDS: dict[str, str] = {
    "titleAbstract": "title_abstract_base_prompt",
    "fullText": "full_text_base_prompt",
    "extraction": "extraction_base_prompt",
    "validation": "validation_base_prompt",
}


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
            "llm_title_abstract_base_prompt": stored.title_abstract_base_prompt,
            "llm_full_text_base_prompt": stored.full_text_base_prompt,
            "llm_extraction_base_prompt": stored.extraction_base_prompt,
            "llm_validation_base_prompt": stored.validation_base_prompt,
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


def update_installation_prompts(
    db: Session,
    *,
    overrides: dict[str, str | None],
    updated_by_user_id: str,
) -> LlmInstallationSettings:
    """Persist per-flow base prompt overrides.

    A value of None (or blank) resets that flow to its built-in default.
    `overrides` keys are the PROMPT_OVERRIDE_FIELDS flow keys; flows absent
    from the dict are left untouched.
    """

    stored = installation_settings(db)
    if stored is None:
        defaults = get_settings()
        stored = LlmInstallationSettings(
            enabled=defaults.llm_enabled,
            endpoint=defaults.ollama_base_url,
            model=defaults.ollama_model,
            context_length=defaults.llm_context_length,
            updated_by_user_id=updated_by_user_id,
        )
        db.add(stored)
    for key, column in PROMPT_OVERRIDE_FIELDS.items():
        if key not in overrides:
            continue
        value = overrides[key]
        normalized = value.strip() if value else None
        setattr(stored, column, normalized or None)
    stored.updated_by_user_id = updated_by_user_id
    db.flush()
    return stored
