from __future__ import annotations

from pydantic import Field

from app.accounts.password_policy import MAX_PASSWORD_LENGTH
from app.api.schemas import ApiModel

# The *length policy* for a new password lives in
# `app.accounts.password_policy` and is enforced by `set_user_password` /
# `create_user`, so every path reports the same requirement with the same
# message. These schemas only bound the field so an oversized body never
# reaches Argon2; a `min_length` matching the policy here would short-circuit
# into an unhelpful 422 instead.
_MIN_SUBMITTED_PASSWORD = 1


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


LoginResponse.model_rebuild()
