from __future__ import annotations

from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from uuid import uuid4

from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.trustedhost import TrustedHostMiddleware

from app.accounts.routes import router as accounts_router
from app.api.errors import install_error_handlers
from app.api.health import router as health_router
from app.audit.routes import router as audit_router
from app.conflicts.routes import router as conflicts_router
from app.core.config import get_settings
from app.core.logging import configure_logging
from app.deduplication.routes import router as deduplication_router
from app.extraction.routes import router as extraction_router
from app.forms.routes import router as forms_router
from app.fulltext.document_routes import router as fulltext_document_router
from app.fulltext.routes import router as fulltext_router
from app.imports.routes import router as imports_router
from app.jobs.routes import router as jobs_router
from app.llm.routes import router as llm_router
from app.projects.routes import router as projects_router
from app.publications.routes import router as publications_router
from app.quality.routes import router as quality_router
from app.reporting.routes import router as reporting_router
from app.screening.routes import router as screening_router


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    settings = get_settings()
    settings.ensure_directories()
    yield


def create_app() -> FastAPI:
    configure_logging()
    settings = get_settings()
    app = FastAPI(title=settings.app_name, version="0.1.0", lifespan=lifespan)
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=settings.allowed_hosts)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.middleware("http")
    async def request_id(
        request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        request_id = request.headers.get("X-Request-ID", str(uuid4()))
        response = await call_next(request)
        response.headers["X-Request-ID"] = request_id
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["Permissions-Policy"] = (
            "camera=(), microphone=(), geolocation=()"
        )
        response.headers["Content-Security-Policy"] = (
            "frame-ancestors 'none'; base-uri 'self'; object-src 'none'"
        )
        if request.url.path.startswith(settings.api_prefix):
            response.headers["Cache-Control"] = "no-store"
        return response

    app.include_router(health_router)
    app.include_router(accounts_router, prefix=settings.api_prefix)
    app.include_router(projects_router, prefix=settings.api_prefix)
    app.include_router(imports_router, prefix=settings.api_prefix)
    app.include_router(jobs_router, prefix=settings.api_prefix)
    app.include_router(llm_router, prefix=settings.api_prefix)
    app.include_router(publications_router, prefix=settings.api_prefix)
    app.include_router(deduplication_router, prefix=settings.api_prefix)
    app.include_router(screening_router, prefix=settings.api_prefix)
    app.include_router(conflicts_router, prefix=settings.api_prefix)
    app.include_router(fulltext_router, prefix=settings.api_prefix)
    app.include_router(fulltext_document_router, prefix=settings.api_prefix)
    app.include_router(forms_router, prefix=settings.api_prefix)
    app.include_router(extraction_router, prefix=settings.api_prefix)
    app.include_router(quality_router, prefix=settings.api_prefix)
    app.include_router(reporting_router, prefix=settings.api_prefix)
    app.include_router(audit_router, prefix=settings.api_prefix)
    install_error_handlers(app)
    return app


app = create_app()
