from __future__ import annotations

from pydantic import BaseModel, ConfigDict


class ApiModel(BaseModel):
    """Canonical base for request/response schemas: accepts either the
    Python field name or its alias, and supports building from ORM
    attributes."""

    model_config = ConfigDict(populate_by_name=True, from_attributes=True)


class EnumApiModel(ApiModel):
    """Same as ApiModel, but coerces enum fields to their plain value on
    validation (``use_enum_values=True``)."""

    model_config = ConfigDict(
        populate_by_name=True, from_attributes=True, use_enum_values=True
    )
