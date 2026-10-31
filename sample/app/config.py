"""Application configuration loaded from environment variables."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from functools import lru_cache
from typing import Optional

DEFAULT_KINDS = ("square", "sum", "reverse", "fib", "sleep", "price", "fail")


def _env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _env_list(name, default):
    raw = os.getenv(name)
    if not raw:
        return tuple(default)
    return tuple(part.strip() for part in raw.split(",") if part.strip())


@dataclass(frozen=True)
class Settings:
    app_name: str = "EEX Sample"
    db_path: str = "sample.db"
    worker_count: int = 2
    queue_maxsize: int = 100
    cache_ttl: float = 30.0
    api_key: Optional[str] = None
    debug: bool = False
    log_level: str = "INFO"
    allowed_kinds: tuple[str, ...] = field(default=DEFAULT_KINDS)

    @classmethod
    def from_env(cls) -> Settings:
        return cls(
            app_name=os.getenv("APP_NAME", cls.app_name),
            db_path=os.getenv("APP_DB_PATH", cls.db_path),
            worker_count=int(os.getenv("APP_WORKERS", cls.worker_count)),
            queue_maxsize=int(os.getenv("APP_QUEUE_MAXSIZE", cls.queue_maxsize)),
            cache_ttl=float(os.getenv("APP_CACHE_TTL", cls.cache_ttl)),
            api_key=os.getenv("APP_API_KEY") or None,
            debug=_env_bool("APP_DEBUG", cls.debug),
            log_level=os.getenv("APP_LOG_LEVEL", cls.log_level),
            allowed_kinds=_env_list("APP_ALLOWED_KINDS", DEFAULT_KINDS),
        )

    @property
    def is_secured(self) -> bool:
        return bool(self.api_key)


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Cached settings accessor; also used as a FastAPI dependency."""
    return Settings.from_env()
