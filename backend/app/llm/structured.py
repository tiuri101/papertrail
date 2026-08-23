from __future__ import annotations

import json
from collections.abc import Callable
from typing import Any, TypeVar

from app.api.errors import DomainError
from app.llm.ollama import OllamaClientProtocol, OllamaResponse

ValidatedResult = TypeVar("ValidatedResult")


def add_metrics(total: dict[str, int], response: OllamaResponse) -> None:
    for key, value in response.metrics.items():
        if value is not None:
            total[key] = total.get(key, 0) + value


def validated_chat(
    client: OllamaClientProtocol,
    messages: list[dict[str, str]],
    schema: dict[str, Any],
    validator: Callable[[dict[str, Any]], ValidatedResult],
) -> tuple[ValidatedResult, OllamaResponse]:
    response = client.chat(messages=messages, output_schema=schema)
    try:
        return validator(response.content), response
    except DomainError as first_error:
        repair_messages = [
            *messages,
            {"role": "assistant", "content": json.dumps(response.content)},
            {
                "role": "user",
                "content": (
                    "Your structured response was invalid. Return a corrected response that "
                    f"strictly matches the JSON schema. Validation error: {first_error}"
                ),
            },
        ]
        repaired = client.chat(messages=repair_messages, output_schema=schema)
        return validator(repaired.content), repaired
