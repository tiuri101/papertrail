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


@dataclass(frozen=True)
class OllamaResponse:
    content: dict[str, Any]
    metrics: dict[str, int | None]


class OllamaClientProtocol(Protocol):
    def test_connection(self) -> dict[str, object]: ...

    def chat(
        self,
        *,
        messages: list[dict[str, str]],
        output_schema: dict[str, Any],
    ) -> OllamaResponse: ...


class OllamaClient:
    def __init__(self, settings: Settings):
        if not settings.ollama_base_url or not settings.ollama_model:
            raise OllamaResponseError("Ollama is not configured")
        self.base_url = settings.ollama_base_url
        self.model = settings.ollama_model
        self.timeout = settings.ollama_request_timeout_seconds
        self.context_length = settings.llm_context_length
        self.headers = (
            {"Authorization": f"Bearer {settings.ollama_api_key}"}
            if settings.ollama_api_key
            else {}
        )

    def test_connection(self) -> dict[str, object]:
        try:
            response = httpx.get(
                f"{self.base_url}/api/tags", headers=self.headers, timeout=self.timeout
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
        names = {
            str(model.get("name") or model.get("model"))
            for model in body.get("models", [])
            if isinstance(model, dict)
        }
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
            "options": {"temperature": 0, "num_ctx": self.context_length},
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


def create_ollama_client() -> OllamaClientProtocol:
    return OllamaClient(effective_llm_settings())
