"""Pricing rules: memoized tax lookup, discount closures, inventory valuation job."""
from __future__ import annotations

from typing import Callable, Optional

from ..cache import memoize
from ..core.master import get_master  # part of the master -> workers -> (local) pricing cycle
from ..db import Database, ItemRepository
from ..logging_setup import get_logger, timed
from ..models import JobCreate, JobOut, Priority

logger = get_logger(__name__)

REGION_TAX = {"eu": 0.21, "us": 0.07, "uk": 0.20, "br": 0.17}
DEFAULT_TAX = 0.15

PriceFn = Callable[[float], float]


@memoize
def tax_rate(region: str) -> float:
    return REGION_TAX.get(region.lower(), DEFAULT_TAX)


def compute_total(price: float, quantity: int, region: str = "eu") -> float:
    return round(price * quantity * (1 + tax_rate(region)), 2)


def make_discount(percent: float) -> PriceFn:
    """Closure factory: returns a function applying `percent` off."""
    factor = 1 - percent / 100

    def apply(price: float) -> float:
        return round(price * factor, 2)

    apply.percent = percent
    return apply


def _floor_price(minimum):
    def decorate(fn: PriceFn) -> PriceFn:
        return lambda price: max(minimum, fn(price))
    return decorate


DISCOUNTS: dict[str, PriceFn] = {
    "none": lambda price: price,
    "ten": make_discount(10),
    "half": make_discount(50),
    "clearance": _floor_price(1.0)(make_discount(90)),
}


def apply_discount(price: float, strategy: str) -> float:
    try:
        fn = DISCOUNTS[strategy]
    except KeyError:
        raise ValueError(f"unknown discount strategy {strategy!r}") from None
    return fn(price)


@timed
def compute_inventory_value(db_path: str, region: Optional[str] = None) -> dict:
    """Sync, runs inside a worker thread."""
    database = Database(db_path)
    total = 0.0
    count = 0
    with database.connect() as conn:
        for item in ItemRepository(conn).iter_all():
            if region and item.region != region:
                continue
            total += compute_total(item.price, item.quantity, item.region)
            count += 1
    logger.info("inventory value %.2f over %d items", total, count)
    return {"items": count, "total": round(total, 2), "region": region}


async def enqueue_revaluation(region: Optional[str] = None, priority: Priority = Priority.LOW) -> JobOut:
    payload = {"region": region} if region else {}
    return await get_master().submit(JobCreate(kind="price", payload=payload, priority=priority))
