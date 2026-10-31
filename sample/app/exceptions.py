"""Domain exceptions and their FastAPI handlers."""
from typing import Any, Optional

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse


class AppError(Exception):
    status_code = 500
    code = "app_error"

    def __init__(self, message: str, *, details: Optional[dict[str, Any]] = None):
        super().__init__(message)
        self.message = message
        self.details = details or {}

    def to_dict(self) -> dict[str, Any]:
        return {"error": self.code, "message": self.message, "details": self.details}


class NotFoundError(AppError):
    status_code = 404
    code = "not_found"

    def __init__(self, entity: str, ident: Any):
        super().__init__(f"{entity} {ident} not found", details={"entity": entity, "id": ident})


class QueueFullError(AppError):
    status_code = 503
    code = "queue_full"


class UnknownJobKindError(AppError):
    status_code = 422
    code = "unknown_job_kind"

    def __init__(self, kind):
        super().__init__(f"Unknown job kind: {kind!r}", details={"kind": kind})


class JobFailedError(AppError):
    code = "job_failed"


async def app_error_handler(request: Request, exc: AppError) -> JSONResponse:
    return JSONResponse(status_code=exc.status_code, content=exc.to_dict())


async def value_error_handler(request, exc):
    return JSONResponse(status_code=400, content={"error": "bad_value", "message": str(exc)})


def register_exception_handlers(app: FastAPI) -> None:
    app.add_exception_handler(AppError, app_error_handler)
    app.add_exception_handler(ValueError, value_error_handler)
