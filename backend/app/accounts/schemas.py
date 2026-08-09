from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field


class ApiModel(BaseModel):
    model_config = ConfigDict(populate_by_name=True, from_attributes=True)


class LoginRequest(ApiModel):
    username: str = Field(min_length=1, max_length=100)
    password: str = Field(min_length=8, max_length=256)


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


class UserCreate(ApiModel):
    username: str = Field(min_length=1, max_length=100)
    display_name: str = Field(alias="displayName", min_length=1, max_length=200)
    password: str = Field(min_length=8, max_length=256)
    email: str | None = Field(default=None, max_length=320)


class UserUpdate(ApiModel):
    display_name: str | None = Field(
        default=None, alias="displayName", min_length=1, max_length=200
    )
    is_active: bool | None = Field(default=None, alias="isActive")
    password: str | None = Field(default=None, min_length=8, max_length=256)
    email: str | None = Field(default=None, max_length=320)


class SelfUpdate(ApiModel):
    display_name: str | None = Field(
        default=None, alias="displayName", min_length=1, max_length=200
    )
    current_password: str | None = Field(
        default=None, alias="currentPassword", min_length=8, max_length=256
    )
    new_password: str | None = Field(
        default=None, alias="newPassword", min_length=8, max_length=256
    )
    email: str | None = Field(default=None, max_length=320)


LoginResponse.model_rebuild()
