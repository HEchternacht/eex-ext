from fastapi import APIRouter, Request

from .. import __version__
from ..config import get_settings

router = APIRouter(tags=["health"])


@router.get("/health")
async def health(request: Request):
    master = getattr(request.app.state, "master", None)
    return {"status": "ok", "workers_running": bool(master and master.running)}


@router.get("/version")
def version() -> dict[str, str]:
    return {"name": get_settings().app_name, "version": __version__}
