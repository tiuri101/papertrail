from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from app.api.errors import DomainError


class RqStatement(BaseModel):
    model_config = ConfigDict(extra="forbid")

    claim: str = Field(min_length=1)
    source_ids: list[str] = Field(default_factory=list, alias="sourceIds")


class RqSynthesisResult(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    statements: list[RqStatement] = Field(default_factory=list)
    limitations: list[str] = Field(default_factory=list)


def validate_rq_synthesis_result(payload: dict[str, Any]) -> RqSynthesisResult:
    try:
        return RqSynthesisResult.model_validate(payload)
    except ValidationError as exc:
        raise DomainError(f"Structured response validation failed: {exc}") from exc
