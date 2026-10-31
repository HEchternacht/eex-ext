"""HTTP middleware: request id, timing header, request counter."""
import time
import uuid

from fastapi import Request

from .logging_setup import get_logger

logger = get_logger(__name__)

REQUEST_COUNT = 0


async def request_context_middleware(request: Request, call_next):
    global REQUEST_COUNT
    REQUEST_COUNT += 1
    request_id = request.headers.get("x-request-id") or uuid.uuid4().hex[:12]
    request.state.request_id = request_id
    start = time.perf_counter()
    response = await call_next(request)
    elapsed_ms = (time.perf_counter() - start) * 1000
    response.headers["X-Request-ID"] = request_id
    response.headers["X-Process-Time-ms"] = f"{elapsed_ms:.2f}"
    logger.debug("%s %s -> %s in %.2f ms", request.method, request.url.path, response.status_code, elapsed_ms)
    return response


def request_count() -> int:
    return REQUEST_COUNT
