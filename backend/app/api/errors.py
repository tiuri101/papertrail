from __future__ import annotations

from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse


class DomainError(Exception):
    status_code = 400
    code = "domain_error"

    def __init__(self, message: str, *, details: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.message = message
        # Optional machine-readable payload accompanying ``code``, for errors
        # a client has to react to specifically rather than just display --
        # e.g. *which* setting a rejected configuration change was locked on.
        self.details: dict[str, Any] | None = details


class NotFoundError(DomainError):
    status_code = 404
    code = "not_found"


class ConflictError(DomainError):
    status_code = 409
    code = "conflict"


class ForbiddenError(DomainError):
    status_code = 403
    code = "forbidden"


class RateLimitError(DomainError):
    status_code = 429
    code = "rate_limited"


class PayloadTooLargeError(DomainError):
    status_code = 413
    code = "payload_too_large"


class UnsupportedMediaError(DomainError):
    status_code = 415
    code = "unsupported_media_type"


def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(DomainError)
    async def handle_domain_error(_: Request, exc: DomainError) -> JSONResponse:
        payload: dict[str, Any] = {"code": exc.code, "message": exc.message}
        details = getattr(exc, "details", None)
        if details:
            payload["details"] = details
        return JSONResponse(status_code=exc.status_code, content={"error": payload})
