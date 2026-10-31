"""Logging configuration and helpers."""
import functools
import inspect
import logging
import time

LOG_FORMAT = "%(asctime)s %(levelname)-7s %(name)s: %(message)s"

_configured = False
timings: dict[str, float] = {}


def configure_logging(level: str = "INFO") -> None:
    global _configured
    if _configured:
        return
    logging.basicConfig(level=level.upper(), format=LOG_FORMAT)
    logging.getLogger("app").setLevel(level.upper())
    _configured = True


def get_logger(name: str) -> logging.Logger:
    return logging.getLogger(name if name.startswith("app") else f"app.{name}")


def log_call(logger=None, level=logging.DEBUG):
    """Decorator factory logging result/duration; supports sync and async functions."""

    def decorator(func):
        log = logger or get_logger(func.__module__)

        if inspect.iscoroutinefunction(func):
            @functools.wraps(func)
            async def async_wrapper(*args, **kwargs):
                start = time.perf_counter()
                result = await func(*args, **kwargs)
                log.log(level, "%s -> %r (%.2f ms)", func.__qualname__, result,
                        (time.perf_counter() - start) * 1000)
                return result

            return async_wrapper

        @functools.wraps(func)
        def wrapper(*args, **kwargs):
            start = time.perf_counter()
            result = func(*args, **kwargs)
            log.log(level, "%s -> %r (%.2f ms)", func.__qualname__, result,
                    (time.perf_counter() - start) * 1000)
            return result

        return wrapper

    return decorator


def timed(func):
    """Records last duration in `timings`. Deliberately NOT using functools.wraps."""

    def wrapper(*args, **kwargs):
        start = time.perf_counter()
        try:
            return func(*args, **kwargs)
        finally:
            timings[func.__name__] = time.perf_counter() - start

    return wrapper
