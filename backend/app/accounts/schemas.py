from __future__ import annotations

import json
from typing import Any

from pydantic import Field, field_validator

from app.accounts.password_policy import MAX_PASSWORD_LENGTH
from app.api.schemas import ApiModel
from app.notifications.preferences import EMAIL_CATEGORY_KEYS

# The *length policy* for a new password lives in
# `app.accounts.password_policy` and is enforced by `set_user_password` /
# `create_user`, so every path reports the same requirement with the same
# message. These schemas only bound the field so an oversized body never
# reaches Argon2; a `min_length` matching the policy here would short-circuit
# into an unhelpful 422 instead.
_MIN_SUBMITTED_PASSWORD = 1

# Reviewer UI preferences (hotkeys, font choices, ...) are opaque to the
# backend, so the only server-side check is a generous size cap -- enough for
# many namespaced preference groups, small enough that a buggy or malicious
# client can't use the users table as unbounded blob storage.
_MAX_UI_PREFERENCES_BYTES = 20_000


class LoginRequest(ApiModel):
    username: str = Field(min_length=1, max_length=100)
    # Deliberately not the new-password minimum: accounts created under an
    # older policy must still be able to sign in (and be told to change it).
    password: str = Field(min_length=_MIN_SUBMITTED_PASSWORD, max_length=MAX_PASSWORD_LENGTH)


class LoginResponse(ApiModel):
    user: UserResponse
    csrf_token: str = Field(serialization_alias="csrfToken")


class UserResponse(ApiModel):
    id: str
    username: str
    display_name: str = Field(serialization_alias="displayName")
    email: str | None = None
    is_admin: bool = Field(serialization_alias="isAdmin")
    is_active: bool = Field(serialization_alias="isActive")
    must_change_password: bool = Field(serialization_alias="mustChangePassword")
    ui_preferences: dict[str, Any] = Field(
        default_factory=dict, serialization_alias="uiPreferences"
    )
    email_preferences: dict[str, bool] = Field(
        default_factory=dict, serialization_alias="emailPreferences"
    )

    @field_validator("email_preferences", mode="before")
    @classmethod
    def resolve_email_preferences(cls, value: Any) -> dict[str, bool]:
        # Always report every optional category, so clients never have to
        # know that a missing key means "enabled".
        stored = value if isinstance(value, dict) else {}
        return {key: bool(stored.get(key, True)) for key in sorted(EMAIL_CATEGORY_KEYS)}


class UserCreate(ApiModel):
    username: str = Field(min_length=1, max_length=100)
    display_name: str = Field(alias="displayName", min_length=1, max_length=200)
    password: str = Field(
        min_length=_MIN_SUBMITTED_PASSWORD, max_length=MAX_PASSWORD_LENGTH
    )
    email: str | None = Field(default=None, max_length=320)


class UserUpdate(ApiModel):
    display_name: str | None = Field(
        default=None, alias="displayName", min_length=1, max_length=200
    )
    is_active: bool | None = Field(default=None, alias="isActive")
    password: str | None = Field(
        default=None, min_length=_MIN_SUBMITTED_PASSWORD, max_length=MAX_PASSWORD_LENGTH
    )
    email: str | None = Field(default=None, max_length=320)


class ForgotPasswordRequest(ApiModel):
    email: str = Field(min_length=1, max_length=320)


class ResetPasswordRequest(ApiModel):
    token: str = Field(min_length=1, max_length=512)
    new_password: str = Field(
        alias="newPassword",
        min_length=_MIN_SUBMITTED_PASSWORD,
        max_length=MAX_PASSWORD_LENGTH,
    )


class SelfUpdate(ApiModel):
    display_name: str | None = Field(
        default=None, alias="displayName", min_length=1, max_length=200
    )
    current_password: str | None = Field(
        default=None,
        alias="currentPassword",
        min_length=_MIN_SUBMITTED_PASSWORD,
        max_length=MAX_PASSWORD_LENGTH,
    )
    new_password: str | None = Field(
        default=None,
        alias="newPassword",
        min_length=_MIN_SUBMITTED_PASSWORD,
        max_length=MAX_PASSWORD_LENGTH,
    )
    email: str | None = Field(default=None, max_length=320)
    # Replaces the stored preferences wholesale when provided -- the frontend
    # always sends the full merged object, so there is no partial-merge
    # ambiguity to resolve server-side.
    ui_preferences: dict[str, Any] | None = Field(default=None, alias="uiPreferences")
    #: Partial update: only the categories present change.
    email_preferences: dict[str, bool] | None = Field(
        default=None, alias="emailPreferences"
    )

    @field_validator("email_preferences")
    @classmethod
    def validate_email_preference_keys(
        cls, value: dict[str, bool] | None
    ) -> dict[str, bool] | None:
        if value is None:
            return value
        unknown = sorted(set(value) - EMAIL_CATEGORY_KEYS)
        if unknown:
            raise ValueError(f"Unknown email categories: {', '.join(unknown)}")
        return value

    @field_validator("ui_preferences")
    @classmethod
    def validate_ui_preferences_size(cls, value: dict[str, Any] | None) -> dict[str, Any] | None:
        if value is None:
            return value
        if len(json.dumps(value)) > _MAX_UI_PREFERENCES_BYTES:
            raise ValueError("Preferences payload is too large")
        return value


LoginResponse.model_rebuild()
