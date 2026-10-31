"""Worker classes that consume the priority queue and execute job handlers."""
from __future__ import annotations

import asyncio
import inspect
from abc import ABC, abstractmethod
from typing import Any, Awaitable, Callable, Union

from ..cache import fibonacci
from ..exceptions import JobFailedError, UnknownJobKindError
from ..logging_setup import get_logger
from ..models import JobStatus, QueuedJob
from .queue import PriorityJobQueue

logger = get_logger(__name__)

processed_total = 0

JobHandler = Callable[[dict[str, Any]], Any]
StatusCallback = Callable[[int, JobStatus, Any, Union[str, None]], Awaitable[None]]


def coerce_number(value: Union[int, float, str]) -> float:
    return float(value)


def _square(payload: dict[str, Any]) -> int:
    n = int(payload["n"])
    return n * n


def _sum(payload):
    return sum(map(coerce_number, payload.get("values", [])))


# Dynamic dispatch table: job kind -> plain function / lambda.
HANDLERS: dict[str, JobHandler] = {
    "square": _square,
    "sum": _sum,
    "reverse": lambda payload: str(payload.get("text", ""))[::-1],
    "fib": lambda payload: fibonacci(int(payload["n"])),
}


class BaseWorker(ABC):
    poll_interval = 0.05

    def __init__(self, name: str, queue: PriorityJobQueue, on_status: StatusCallback):
        self.name = name
        self.queue = queue
        self.on_status = on_status
        self.processed = 0
        self.current: QueuedJob | None = None
        self._stopping = False

    @abstractmethod
    async def process(self, job: QueuedJob) -> Any:
        """Execute the job and return a JSON-serialisable result."""

    @property
    def busy(self) -> bool:
        return self.current is not None

    def stop(self) -> None:
        self._stopping = True

    async def run(self) -> None:
        logger.info("%s started", self.name)
        while not self._stopping:
            job = await self.queue.get(timeout=self.poll_interval)
            if job is None:
                continue
            await self._handle(job)
        logger.info("%s stopped after %d jobs", self.name, self.processed)

    async def _handle(self, job: QueuedJob) -> None:
        global processed_total
        self.current = job
        await self.on_status(job.job_id, JobStatus.RUNNING, None, None)
        try:
            result = await self.process(job)
        except Exception as exc:  # job failures must not kill the worker loop
            logger.warning("%s: job %s (%s) failed: %s", self.name, job.job_id, job.kind, exc)
            status, result, error = JobStatus.FAILED, None, str(exc)
        else:
            status, error = JobStatus.DONE, None
        finally:
            self.current = None
        self.processed += 1
        processed_total += 1
        await self.on_status(job.job_id, status, result, error)

    def summary(self) -> dict[str, Any]:
        return {"name": self.name, "type": type(self).__name__,
                "processed": self.processed, "busy": self.busy}


class AsyncWorker(BaseWorker):
    """Runs handlers inline on the event loop."""

    def resolve_handler(self, kind: str) -> Callable[..., Any]:
        method = getattr(self, f"handle_{kind}", None)  # getattr-based dispatch first
        if method is not None:
            return method
        try:
            return HANDLERS[kind]
        except KeyError:
            raise UnknownJobKindError(kind) from None

    async def process(self, job: QueuedJob) -> Any:
        handler = self.resolve_handler(job.kind)
        result = handler(job.payload)
        if inspect.isawaitable(result):
            result = await result
        return result

    async def handle_sleep(self, payload: dict[str, Any]) -> str:
        await asyncio.sleep(float(payload.get("seconds", 0.01)))
        return "slept"

    async def handle_fail(self, payload):
        raise JobFailedError(payload.get("reason", "requested failure"))


class ThreadedWorker(AsyncWorker):
    """Overrides process(): sync handlers are offloaded to a thread."""

    async def process(self, job: QueuedJob) -> Any:
        handler = self.resolve_handler(job.kind)
        if inspect.iscoroutinefunction(handler):
            return await handler(job.payload)
        return await asyncio.to_thread(handler, job.payload)

    def handle_price(self, payload: dict[str, Any]) -> dict[str, Any]:
        # Local imports: services.pricing imports core.master, which imports this module.
        from ..config import get_settings
        from ..services.pricing import compute_inventory_value

        db_path = payload.get("db_path") or get_settings().db_path
        return compute_inventory_value(db_path, region=payload.get("region"))
