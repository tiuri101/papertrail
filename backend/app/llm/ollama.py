from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Protocol

import httpx

from app.core.config import Settings
from app.llm.installation_settings import effective_llm_settings


class OllamaError(RuntimeError):
    transient = False


class OllamaTransientError(OllamaError):
    transient = True


class OllamaResponseError(OllamaError):
    pass


class OllamaTruncatedError(OllamaTransientError):
    """The model hit the output token limit, most likely by looping.

    Retryable because a retry samples differently (see ``RETRY_TEMPERATURE``).
    """


class OllamaContextOverflowError(OllamaTransientError):
    """Prompt and output together filled the context window.

    Retryable because a job retry splits its input into smaller chunks.
    """


# Ollama stops one token short of a full window.
CONTEXT_FULL_MARGIN_TOKENS = 16

# A retry of an identical request at temperature 0 reproduces the same output,
# so a model stuck repeating itself on one document would simply loop again.
RETRY_TEMPERATURE = 0.3
REPEAT_PENALTY = 1.1


def sampling_temperature(attempt: int) -> float:
    return 0 if attempt <= 1 else RETRY_TEMPERATURE


def with_attempt_sampling(
    model_configuration: dict[str, Any] | None, attempt: int
) -> dict[str, Any]:
    """Return a run's recorded model configuration with this attempt's temperature."""
    return {
        **(model_configuration or {}),
        "temperature": sampling_temperature(attempt),
    }


@dataclass(frozen=True)
class OllamaResponse:
    content: dict[str, Any]
    metrics: dict[str, int | None]


class OllamaClientProtocol(Protocol):
    def test_connection(self) -> dict[str, object]:
        ...

    def chat(
        self,
        *,
        messages: list[dict[str, str]],
        output_schema: dict[str, Any],
    ) -> OllamaResponse:
        ...


def fetch_ollama_models(
    base_url: str, *, headers: dict[str, str], timeout: int
) -> list[str]:
    """Return the model tags installed on an Ollama server, sorted and de-duplicated.

    Requires only a base URL, so it can be called before a model has been chosen.
    """
    try:
        response = httpx.get(
            f"{base_url}/api/tags", headers=headers, timeout=timeout
        )
        response.raise_for_status()
        body = response.json()
    except (httpx.TimeoutException, httpx.NetworkError) as exc:
        raise OllamaTransientError("Ollama is unreachable") from exc
    except httpx.HTTPStatusError as exc:
        if exc.response.status_code >= 500:
            raise OllamaTransientError("Ollama returned a server error") from exc
        raise OllamaResponseError(
            f"Ollama returned HTTP {exc.response.status_code}"
        ) from exc
    except (ValueError, TypeError) as exc:
        raise OllamaResponseError("Ollama returned an invalid response") from exc
    return sorted(
        {
            str(model.get("name") or model.get("model"))
            for model in body.get("models", [])
            if isinstance(model, dict) and (model.get("name") or model.get("model"))
        }
    )


class OllamaClient:
    def __init__(self, settings: Settings, *, attempt: int = 1):
        if not settings.ollama_base_url or not settings.ollama_model:
            raise OllamaResponseError("Ollama is not configured")
        self.base_url = settings.ollama_base_url
        self.model = settings.ollama_model
        self.timeout = settings.ollama_request_timeout_seconds
        self.context_length = settings.llm_context_length
        self.max_output_tokens = settings.llm_max_output_tokens
        self.temperature = sampling_temperature(attempt)
        self.headers = (
            {"Authorization": f"Bearer {settings.ollama_api_key}"}
            if settings.ollama_api_key
            else {}
        )

    def test_connection(self) -> dict[str, object]:
        names = fetch_ollama_models(
            self.base_url, headers=self.headers, timeout=self.timeout
        )
        return {
            "available": True,
            "modelAvailable": self.model in names,
            "model": self.model,
        }

    def chat(
        self,
        *,
        messages: list[dict[str, str]],
        output_schema: dict[str, Any],
    ) -> OllamaResponse:
        payload = {
            "model": self.model,
            "messages": messages,
            "stream": False,
            "think": False,
            "format": output_schema,
            "options": {
                "temperature": self.temperature,
                "num_ctx": self.context_length,
                "num_predict": self.max_output_tokens,
                "repeat_penalty": REPEAT_PENALTY,
            },
        }
        try:
            response = httpx.post(
                f"{self.base_url}/api/chat",
                headers=self.headers,
                json=payload,
                timeout=self.timeout,
            )
            response.raise_for_status()
            body = response.json()
        except (httpx.TimeoutException, httpx.NetworkError) as exc:
            raise OllamaTransientError(
                "Ollama request timed out or was interrupted"
            ) from exc
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code >= 500 or exc.response.status_code == 429:
                raise OllamaTransientError(
                    f"Ollama temporarily returned HTTP {exc.response.status_code}"
                ) from exc
            raise OllamaResponseError(
                f"Ollama returned HTTP {exc.response.status_code}"
            ) from exc
        except (ValueError, TypeError) as exc:
            raise OllamaResponseError("Ollama returned invalid JSON") from exc
        if body.get("done_reason") == "length":
            prompt_tokens = body.get("prompt_eval_count")
            output_tokens = body.get("eval_count")
            if (
                isinstance(prompt_tokens, int)
                and isinstance(output_tokens, int)
                and prompt_tokens + output_tokens
                >= self.context_length - CONTEXT_FULL_MARGIN_TOKENS
            ):
                raise OllamaContextOverflowError(
                    f"Ollama ran out of context: the prompt ({prompt_tokens} tokens) "
                    f"and output ({output_tokens} tokens) filled the "
                    f"{self.context_length}-token context window"
                )
            raise OllamaTruncatedError(
                "Ollama output was truncated at the output token limit "
                f"({self.max_output_tokens} tokens); the model was likely "
                "repeating itself"
            )
        try:
            content = json.loads(body["message"]["content"])
        except (KeyError, TypeError, json.JSONDecodeError) as exc:
            raise OllamaResponseError(
                "Ollama response did not contain structured JSON"
            ) from exc
        metric_names = (
            "total_duration",
            "load_duration",
            "prompt_eval_count",
            "prompt_eval_duration",
            "eval_count",
            "eval_duration",
        )
        metrics = {
            name: int(body[name]) if isinstance(body.get(name), (int, float)) else None
            for name in metric_names
        }
        return OllamaResponse(content=content, metrics=metrics)


def create_ollama_client(*, attempt: int = 1) -> OllamaClientProtocol:
    """``attempt`` is the background job's attempt number; retries sample differently."""
    return OllamaClient(effective_llm_settings(), attempt=attempt)
