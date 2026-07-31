from pydantic import BaseModel, ConfigDict, Field


class ApiModel(BaseModel):
    model_config = ConfigDict(
        from_attributes=True, populate_by_name=True, use_enum_values=True
    )


class FormCreate(ApiModel):
    name: str
    kind: str
    template_id: str | None = Field(default=None, alias="templateId")


class FieldCreate(ApiModel):
    label: str
    field_type: str = Field(alias="fieldType")
    required: bool = False
    options: list = []
    scoring: dict = {}


class FieldResponse(ApiModel):
    id: str
    stable_key: str = Field(serialization_alias="stableKey")
    label: str
    field_type: str = Field(serialization_alias="fieldType")
    required: bool
    position: int
    options: list
    scoring: dict
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
    archive: bool = False


class SaveAsTemplateRequest(ApiModel):
    name: str | None = None


class FieldReplace(ApiModel):
    field_type: str = Field(alias="fieldType")
    label: str | None = None
    required: bool = False
    options: list = []
    scoring: dict = {}
