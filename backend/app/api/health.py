"""Liveness/readiness probes and the authenticated system-information route.

``/health`` and ``/ready`` stay unauthenticated because container health checks,
the reverse proxy, and uptime monitors call them without credentials. They
therefore say only whether the process is up, and deliberately do not report the
running Papertrail version: an unauthenticated version banner is a free
"which published advisories apply to this host?" lookup for a scanner. The
version is still logged at startup and is available to signed-in installation
administrators through ``/api/v1/system/info``.
"""

from fastapi import APIRouter, Depends

from app.accounts.dependencies import require_admin
from app.accounts.models import User
from app.core.config import get_settings

router = APIRouter(tags=["system"])
system_router = APIRouter(tags=["system"])


@router.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@router.get("/ready")
def ready() -> dict[str, str]:
    return {"status": "ready"}


@system_router.get("/system/info")
def system_info(_: User = Depends(require_admin)) -> dict[str, str]:
    settings = get_settings()
    return {
        "name": settings.app_name,
        "version": settings.app_version,
        "environment": settings.env,
    }
