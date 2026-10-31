from fastapi import APIRouter

from . import admin, items, jobs
from .health import router as health_router

api_router = APIRouter(prefix="/api/v1")
api_router.include_router(items.router)
api_router.include_router(jobs.router)
api_router.include_router(admin.router)

__all__ = ["api_router", "health_router"]
