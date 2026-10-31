"""Master: persists jobs, dispatches them to workers through the priority queue."""
from __future__ import annotations

import asyncio
from typing import Any, Callable, Optional

from ..cache import get_cache
from ..db import Database, JobRepository
from ..exceptions import QueueFullError
from ..logging_setup import get_logger, log_call
from ..models import JobCreate, JobOut, JobStatus
from .queue import PriorityJobQueue
from .workers import BaseWorker, ThreadedWorker

logger = get_logger(__name__)

# Module-level mutable state (mutated without `global`, since only items change).
master_stats: dict[str, int] = {"submitted": 0, "completed": 0, "failed": 0}
_master: Optional[Master] = None

Listener = Callable[[int, JobStatus], None]


class Master:
    def __init__(self, database: Database, worker_count: int = 2, queue_maxsize: int = 0,
                 worker_cls: type[BaseWorker] = ThreadedWorker):
        self.database = database
        self.queue = PriorityJobQueue(maxsize=queue_maxsize)
        self.workers = [worker_cls(f"worker-{i}", self.queue, self._on_status)
                        for i in range(worker_count)]
        self._tasks: list[asyncio.Task] = []
        self._listeners: list[Listener] = []

    @property
    def running(self) -> bool:
        return any(not t.done() for t in self._tasks)

    def add_listener(self, callback: Listener) -> None:
        self._listeners.append(callback)

    async def start(self) -> None:
        self._tasks = [asyncio.create_task(w.run(), name=w.name) for w in self.workers]
        logger.info("master started %d workers", len(self.workers))

    async def stop(self, timeout: float = 2.0) -> None:
        for worker in self.workers:
            worker.stop()
        done, pending = await asyncio.wait(self._tasks, timeout=timeout) if self._tasks else (set(), set())
        for task in pending:
            task.cancel()
        dropped = self.queue.drain()
        if dropped:
            logger.warning("dropping %d queued jobs on shutdown", len(dropped))
        self._tasks = []

    @log_call()
    async def submit(self, job: JobCreate) -> JobOut:
        if self.queue.full():
            raise QueueFullError("job queue is full", details={"maxsize": self.queue.maxsize})
        with self.database.connect() as conn:
            record = JobRepository(conn).create(job, status=JobStatus.QUEUED)
        await self.queue.put(record.id, record.kind, record.payload, record.priority)
        master_stats["submitted"] += 1
        return record

    async def submit_many(self, jobs: list[JobCreate]) -> list[JobOut]:
        return [await self.submit(j) for j in sorted(jobs, key=lambda j: j.priority)]

    async def _on_status(self, job_id: int, status: JobStatus, result: Any, error: Optional[str]) -> None:
        """Callback handed to every worker."""
        with self.database.connect() as conn:
            JobRepository(conn).update_status(job_id, status, result=result, error=error)
        if status is JobStatus.DONE:
            master_stats["completed"] += 1
        elif status is JobStatus.FAILED:
            master_stats["failed"] += 1
        get_cache().invalidate(("job", job_id))
        for listener in self._listeners:
            listener(job_id, status)

    def summary(self) -> dict[str, Any]:
        return {
            "running": self.running,
            "queued": len(self.queue),
            "workers": [w.summary() for w in self.workers],
            **master_stats,
        }


def set_master(master: Optional[Master]) -> None:
    global _master
    _master = master


def get_master() -> Master:
    if _master is None:
        raise RuntimeError("master not started (app lifespan not running)")
    return _master
