"""Unit tests for pieces that don't need the HTTP layer."""
import asyncio

import pytest

from app.cache import TTLCache, fibonacci, memoize
from app.core.queue import PriorityJobQueue
from app.core.workers import AsyncWorker
from app.exceptions import QueueFullError, UnknownJobKindError
from app.models import JobStatus, QueuedJob
from app.services.pricing import DISCOUNTS, compute_total, make_discount, tax_rate
from app.services.report_service import collect_summaries


class FakeClock:
    def __init__(self):
        self.now = 0.0

    def __call__(self):
        return self.now


def test_ttl_cache_expiry_and_eviction():
    clock = FakeClock()
    cache = TTLCache(ttl=10, maxsize=2, clock=clock)
    cache.set("a", 1)
    cache.set("b", 2)
    assert cache.get("a") == 1
    clock.now = 11
    assert cache.get("a") is None
    cache.set("c", 3)
    cache.set("d", 4)
    assert len(cache) == 2 and "d" in cache
    assert cache.summary()["misses"] == 1


def test_memoize_and_lru():
    calls = []

    @memoize
    def double(x):
        calls.append(x)
        return x * 2

    assert double(2) == double(2) == 4
    assert calls == [2]
    assert double.__name__ == "inner"  # no functools.wraps
    assert fibonacci(30) == 832040
    assert tax_rate("US") == 0.07


def test_pricing_closures():
    assert compute_total(10, 3, "uk") == 36.0
    assert make_discount(25)(80) == 60.0
    assert DISCOUNTS["clearance"](5.0) == 1.0


def test_priority_queue_ordering():
    async def scenario():
        queue = PriorityJobQueue(maxsize=3)
        await queue.put(1, "a", {}, 5)
        await queue.put(2, "b", {}, 0)
        await queue.put(3, "c", {}, 5)
        with pytest.raises(QueueFullError):
            await queue.put(4, "d", {}, 0)
        order = [(await queue.get()).job_id for _ in range(3)]
        assert await queue.get(timeout=0.01) is None
        return order

    assert asyncio.run(scenario()) == [2, 1, 3]


def test_async_worker_dispatch():
    updates = []

    async def on_status(job_id, status, result, error):
        updates.append((job_id, status, result, error))

    async def scenario():
        queue = PriorityJobQueue()
        worker = AsyncWorker("w", queue, on_status)
        await worker._handle(QueuedJob(0, 0, 1, "square", {"n": 4}))
        await worker._handle(QueuedJob(0, 1, 2, "missing", {}))
        with pytest.raises(UnknownJobKindError):
            worker.resolve_handler("missing")

    asyncio.run(scenario())
    assert updates[1] == (1, JobStatus.DONE, 16, None)
    assert updates[3][1] is JobStatus.FAILED


def test_collect_summaries_duck_typing():
    class HasSummary:
        def summary(self):
            return {"ok": True}

    out = collect_summaries({"obj": HasSummary(), "fn": lambda: 3, "map": {"k": 1}, "other": 5})
    assert out == {"obj": {"ok": True}, "fn": 3, "map": {"k": 1}, "other": "5"}
