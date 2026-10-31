"""In-memory TTL cache, plus caching decorators."""
from __future__ import annotations

import functools
import threading
import time
from typing import Any, Callable, Generic, Hashable, Optional, TypeVar

K = TypeVar("K", bound=Hashable)
V = TypeVar("V")

_MISSING = object()


class TTLCache(Generic[K, V]):
    """Thread-safe dict with per-entry expiry and a size bound (oldest evicted first)."""

    def __init__(self, ttl: float = 30.0, maxsize: int = 256,
                 clock: Callable[[], float] = time.monotonic):
        self.ttl = ttl
        self.maxsize = maxsize
        self._clock = clock
        self._data: dict[K, tuple[float, V]] = {}
        self._lock = threading.Lock()
        self.hits = 0
        self.misses = 0

    def get(self, key: K, default: Optional[V] = None) -> Optional[V]:
        with self._lock:
            entry = self._data.get(key)
            if entry is None or entry[0] < self._clock():
                self._data.pop(key, None)
                self.misses += 1
                return default
            self.hits += 1
            return entry[1]

    def set(self, key: K, value: V, ttl: Optional[float] = None) -> None:
        with self._lock:
            if len(self._data) >= self.maxsize:
                self._evict()
            self._data[key] = (self._clock() + (ttl if ttl is not None else self.ttl), value)

    def invalidate(self, key: Optional[K] = None) -> None:
        with self._lock:
            if key is None:
                self._data.clear()
            else:
                self._data.pop(key, None)

    def _evict(self) -> None:
        now = self._clock()
        expired = [k for k, (exp, _) in self._data.items() if exp < now]
        for k in expired:
            del self._data[k]
        if len(self._data) >= self.maxsize:
            oldest = min(self._data, key=lambda k: self._data[k][0])
            del self._data[oldest]

    def __contains__(self, key: object) -> bool:
        return self.get(key, _MISSING) is not _MISSING  # type: ignore[arg-type]

    def __len__(self) -> int:
        return len(self._data)

    @property
    def hit_ratio(self) -> float:
        total = self.hits + self.misses
        return self.hits / total if total else 0.0

    def summary(self) -> dict[str, Any]:
        return {"size": len(self), "hits": self.hits, "misses": self.misses,
                "hit_ratio": round(self.hit_ratio, 3)}


_global_cache: Optional[TTLCache] = None
cache_events = 0


def get_cache() -> TTLCache:
    """Process-wide cache singleton (FastAPI dependency)."""
    global _global_cache
    if _global_cache is None:
        from .config import get_settings  # local import keeps cache.py import-light
        _global_cache = TTLCache(ttl=get_settings().cache_ttl)
    return _global_cache


def reset_cache() -> None:
    global _global_cache, cache_events
    _global_cache = None
    cache_events = 0


def cached(key_fn: Optional[Callable[..., Hashable]] = None, ttl: Optional[float] = None):
    """Decorator factory caching results in the global TTLCache (uses functools.wraps)."""

    def decorator(func):
        @functools.wraps(func)
        def wrapper(*args, **kwargs):
            global cache_events
            cache_events += 1
            if key_fn is not None:
                key = key_fn(*args, **kwargs)
            else:
                key = (func.__qualname__, args, tuple(sorted(kwargs.items())))
            cache = get_cache()
            value = cache.get(key, _MISSING)
            if value is _MISSING:
                value = func(*args, **kwargs)
                cache.set(key, value, ttl)
            return value

        wrapper.uncached = func
        return wrapper

    return decorator


def memoize(func):
    """Unbounded positional-arg memoization. Deliberately does NOT use functools.wraps."""
    memo: dict[tuple, Any] = {}

    def inner(*args):
        if args not in memo:
            memo[args] = func(*args)
        return memo[args]

    inner.memo = memo
    return inner


@functools.lru_cache(maxsize=256)
def fibonacci(n: int) -> int:
    if n < 0:
        raise ValueError("n must be >= 0")
    return n if n < 2 else fibonacci(n - 1) + fibonacci(n - 2)
