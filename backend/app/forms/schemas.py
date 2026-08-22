from typing import Any

from pydantic import Field

from app.api.schemas import EnumApiModel as ApiModel


class FormCreate(ApiModel):
    name: str
    kind: str
    template_id: str | None = Field(default=None, alias="templateId")


class FormUpdate(ApiModel):
    name: str = Field(min_length=1, max_length=300)


class FieldCreate(ApiModel):
    label: str
    field_type: str = Field(alias="fieldType")
    required: bool = False
    options: list[Any] = []
    scoring: dict[str, Any] = {}


class FieldResponse(ApiModel):
    id: str
    stable_key: str = Field(serialization_alias="stableKey")
    label: str
    field_type: str = Field(serialization_alias="fieldType")
    required: bool
    position: int
    options: list[Any]
    scoring: dict[str, Any]
    is_archived: bool = Field(serialization_alias="isArchived")


class FormResponse(ApiModel):
    id: str
    project_id: str | None = Field(serialization_alias="projectId")
    name: str
    kind: str
    is_template: bool = Field(serialization_alias="isTemplate")
    active_version_id: str | None = Field(serialization_alias="activeVersionId")


class FieldUpdate(ApiModel):
    label: str | None = None
    field_type: str | None = Field(default=None, alias="fieldType")
    required: bool | None = None
    position: int | None = Field(default=None, ge=0)
    options: list[Any] | None = None
    scoring: dict[str, Any] | None = None
    archive: bool = False


class SaveAsTemplateRequest(ApiModel):
    name: str | None = None


class FieldReplace(ApiModel):
    field_type: str = Field(alias="fieldType")
    label: str | None = None
    required: bool = False
    position: int | None = Field(default=None, ge=0)
    options: list[Any] = []
    scoring: dict[str, Any] = {}
