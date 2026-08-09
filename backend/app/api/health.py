from fastapi import APIRouter

from app.core.config import get_settings

router = APIRouter(tags=["system"])


@router.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "version": get_settings().app_version}


@router.get("/ready")
def ready() -> dict[str, str]:
    return {"status": "ready"}
