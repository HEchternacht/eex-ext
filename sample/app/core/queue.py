"""Heap-backed priority queue with async blocking get."""
from __future__ import annotations

import asyncio
import heapq
import itertools
from typing import Any, Optional

from ..exceptions import QueueFullError
from ..models import QueuedJob


class PriorityJobQueue:
    """Lower priority value = served first; FIFO among equal priorities (via seq)."""

    def __init__(self, maxsize: int = 0):
        self._heap: list[QueuedJob] = []
        self._seq = itertools.count()
        self.maxsize = maxsize
        self._condition: Optional[asyncio.Condition] = None

    @property
    def condition(self) -> asyncio.Condition:
        # Created lazily so it binds to the running event loop.
        if self._condition is None:
            self._condition = asyncio.Condition()
        return self._condition

    def full(self) -> bool:
        return 0 < self.maxsize <= len(self._heap)

    def __len__(self) -> int:
        return len(self._heap)

    async def put(self, job_id: int, kind: str, payload: dict[str, Any], priority: int) -> QueuedJob:
        if self.full():
            raise QueueFullError(f"queue is full ({self.maxsize})")
        entry = QueuedJob(priority, next(self._seq), job_id, kind, payload)
        async with self.condition:
            heapq.heappush(self._heap, entry)
            self.condition.notify()
        return entry

    async def get(self, timeout: Optional[float] = None) -> Optional[QueuedJob]:
        """Pop the highest-priority entry, or return None after `timeout` seconds."""
        cond = self.condition
        async with cond:
            try:
                await asyncio.wait_for(cond.wait_for(lambda: bool(self._heap)), timeout)
            except TimeoutError:
                return None
            return heapq.heappop(self._heap)

    def peek(self) -> Optional[QueuedJob]:
        return self._heap[0] if self._heap else None

    def drain(self) -> list[QueuedJob]:
        items = sorted(self._heap)
        self._heap.clear()
        return items
