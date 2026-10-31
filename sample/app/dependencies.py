"""Shared FastAPI dependencies. Chain: settings -> database -> connection -> repo -> service."""
import sqlite3
from typing import Annotated, Optional

from fastapi import Depends, Header, HTTPException, Query, Request, status

from .cache import TTLCache, get_cache
from .config import Settings, get_settings
from .core.master import Master
from .db import ItemRepository, JobRepository, get_db
from .services import ItemService

SettingsDep = Annotated[Settings, Depends(get_settings)]


def get_item_repo(conn: sqlite3.Connection = Depends(get_db)) -> ItemRepository:
    return ItemRepository(conn)


def get_job_repo(conn=Depends(get_db)):
    """get the job repo"""
    return JobRepository(conn)


def get_item_service(
    settings: SettingsDep,
    repo: ItemRepository = Depends(get_item_repo),
    cache: TTLCache = Depends(get_cache),
) -> ItemService:
    return ItemService(repo, cache, settings)


def get_master_dep(request: Request) -> Master:
    return request.app.state.master


def verify_api_key(settings: SettingsDep, x_api_key: Optional[str] = Header(default=None)) -> None:
    if settings.is_secured and x_api_key != settings.api_key:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="invalid or missing API key")


class Pagination:
    """Class used as a dependency: FastAPI calls __init__ with query params."""

    def __init__(self, limit: int = Query(20, ge=1, le=100), offset: int = Query(0, ge=0)):
        self.limit = limit
        self.offset = offset
